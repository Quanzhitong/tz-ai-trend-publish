/**
 * 健壮的工作流执行基础设施
 * 适合需要重试、超时控制和详细监控的分布式任务处理场景。
 */
import { Logger } from "@zilla/logger";
import { MetricsCollector } from "@src/works/metrics.ts";
import { RetryOptions, RetryUtil } from "@src/utils/retry.util.ts";
import { WorkflowStepError, WorkflowTerminateError } from "./workflow-error.ts";

// 创建日志记录器实例，用于工作流相关日志
const logger = new Logger("workflow");

// 工作流 事件接口：表示工作流执行时的事件数据
export interface WorkflowEvent<T = any> {
  payload: T;        // 事件携带的有效数据
  id: string;         // 事件唯一标识
  timestamp: number;  // 事件发生时间戳
}

// 工作流 步骤配置选项
export interface WorkflowStepOptions {
  retries?: {         // 重试策略配置
    limit: number;    // 最大重试次数
    delay: string | number;  // 重试延迟时间（支持字符串描述如"5 seconds"）
    backoff: "linear" | "exponential";  // 重试间隔策略
  };
  timeout?: string | number;  // 步骤执行超时时间
}

// 工作流 步骤执行器：封装单个步骤的执行逻辑
export class WorkflowStep {
  private stepId: string;           // 当前步骤ID
  private startTime: number;        // 步骤开始时间戳
  private metricsCollector?: MetricsCollector;  // 指标收集器（可选）
  private workflowId?: string;      // 所属工作流ID（可选）
  private eventId?: string;         // 关联事件ID（可选）

  constructor(
    stepId: string,
    metricsCollector?: MetricsCollector,
    workflowId?: string,
    eventId?: string,
  ) {
    this.stepId = stepId;
    this.startTime = Date.now(); // 构造函数内部使用 Date.now() 自动设置
    this.metricsCollector = metricsCollector;
    this.workflowId = workflowId;
    this.eventId = eventId;
  }

  // 执行工作流步骤的核心方法
  async do<T>(
    name: string,  // 步骤名称
    optionsOrFn: WorkflowStepOptions | (() => Promise<T>),  // 配置选项或执行函数
    fn?: () => Promise<T>,  // 执行函数（当optionsOrFn是配置时）
  ): Promise<T> {
    // 解析参数：区分是配置还是函数
    const options: WorkflowStepOptions = typeof optionsOrFn === "function"
      ? {}
      : optionsOrFn;
    const execFn = typeof optionsOrFn === "function" ? optionsOrFn : fn!;
    const stepStartTime = Date.now();  // 记录步骤开始时间

    try {
      // 构建重试配置
      const retryOptions: RetryOptions = {
        maxRetries: options.retries?.limit || 3,
        baseDelay: this.parseDelay(options.retries?.delay || "1 second"),
        useExponentialBackoff: options.retries?.backoff === "exponential",
      };

      // 解析超时时间（默认30分钟）
      const timeoutMs = this.parseDelay(options.timeout || "30 minutes");
      
      // 包装执行函数：添加超时控制和错误处理
      const operationWithTimeout = async () => {
        try {
          // 执行带超时的函数
          return await this.executeWithTimeout(execFn, timeoutMs);
        } catch (error) {
          // 终止错误直接抛出（不重试）
          if (error instanceof WorkflowTerminateError) throw error;
          // 其他错误转换为步骤错误
          throw new WorkflowStepError(
            error instanceof Error ? error.message : String(error),
          );
        }
      };

      // 执行带重试逻辑的操作
      const retryResult = await RetryUtil.retryOperationWithStats(
        operationWithTimeout,
        retryOptions,
      );

      // 记录步骤指标（如果配置了指标收集器）
      if (this.metricsCollector && this.workflowId && this.eventId) {
        this.metricsCollector.recordStep(this.workflowId, this.eventId, {
          stepId: this.stepId,
          name,
          startTime: stepStartTime,
          endTime: Date.now(),
          status: retryResult.success ? "success" : "failure",
          attempts: retryResult.attempts,
          error: retryResult.error?.message,
        });
      }

      // 处理失败结果
      if (!retryResult.success) throw retryResult.error;

      // 记录成功日志
      logger.info(
        `Step ${name} completed successfully after ${retryResult.attempts} attempts, time: ${
          Date.now() - stepStartTime
        }ms`,
      );
      return retryResult.result;
    } catch (error: any) {
      // 处理终止错误
      if (error instanceof WorkflowTerminateError) {
        logger.error(`Step ${name} terminated: ${error.message}`);
        // 记录终止指标
        if (this.metricsCollector && this.workflowId && this.eventId) {
          this.metricsCollector.recordStep(this.workflowId, this.eventId, {
            stepId: this.stepId,
            name,
            startTime: stepStartTime,
            endTime: Date.now(),
            status: "failure",
            attempts: 1,
            error: `Terminated: ${error.message}`,
          });
        }
        throw error;
      }

      // 处理常规错误
      logger.error(`Step ${name} failed: ${error.message}`);
      throw error;
    }
  }

  // 暂停执行指定时间
  async sleep(reason: string, duration: string | number): Promise<void> {
    const ms = this.parseDelay(duration);
    logger.info(`Sleeping for ${ms}ms: ${reason}`);
    await new Promise((resolve) => setTimeout(resolve, ms));
  }

  /**
   * 带超时控制的函数执行器
   * 必要的超时保护，是工作流引擎中防止任务卡死的关键安全机制。
   * 不过可能有问题：超时后资源不会自动释放
   */
  private async executeWithTimeout<T>(
    fn: () => Promise<T>,  // 异步执行函数
    timeout: number,        // 超时时间（毫秒）
  ): Promise<T> {
    return Promise.race([
      fn(),  // 执行目标函数
      // 超时控制器
      new Promise<T>((_, reject) => {
        setTimeout(() => reject(new Error("Step timeout")), timeout);
      }),
    ]);
  }

  // 将时间描述转换为毫秒数
  private parseDelay(delay: string | number): number {
    if (typeof delay === "number") return delay;
    if (delay === "0") return 0;  // 特殊处理零延迟

    // 时间单位映射表
    const units: Record<string, number> = {
      second: 1000,
      minute: 60 * 1000,
      hour: 60 * 60 * 1000,
      day: 24 * 60 * 60 * 1000,
    };

    // 解析时间字符串（如"5 minutes"）
    const match = delay.match(/^(\d+)\s+(second|minute|hour|day)s?$/);
    if (!match) {
      logger.warn(`Invalid delay format: ${delay}, using 0 as default`);
      return 0;
    }

    // 计算毫秒值
    const [, value, unit] = match;
    return parseInt(value) * units[unit];
  }
}

// 工作流 环境配置接口
export interface WorkflowEnv<TEnv = any> {
  id: string;     // 环境ID
  env: TEnv;      // 环境特定配置
}

// 工作流 入口抽象类：定义工作流执行框架
export abstract class WorkflowEntrypoint<TEnv = any, TParams = any> {
  protected env: WorkflowEnv<TEnv>;          // 工作流环境
  protected metricsCollector: MetricsCollector;  // 指标收集器

  constructor(env: WorkflowEnv<TEnv>) {
    this.env = env;
    this.metricsCollector = new MetricsCollector();  // 初始化指标收集
  }

  // 工作流执行入口方法
  async execute(event: WorkflowEvent<TParams>): Promise<void> {
    // 记录工作流开始
    this.metricsCollector.startWorkflow(this.env.id, event.id);
    
    // 创建步骤执行器
    const step = new WorkflowStep(
      "local-step-execution",
      this.metricsCollector,
      this.env.id,
      event.id,
    );

    try {
      // 执行具体工作流逻辑（由子类实现）
      await this.run(event, step);
      // 记录工作流成功结束
      this.metricsCollector.endWorkflow(this.env.id, event.id);
    } catch (error: any) {
      // 处理工作流执行错误
      const isTerminated = error instanceof WorkflowTerminateError;
      // 记录错误指标
      this.metricsCollector.endWorkflow(this.env.id, event.id, error);

      // 根据错误类型记录日志
      if (isTerminated) {
        logger.warn(`Workflow terminated: ${error.message}`);
      } else {
        logger.error(`Workflow failed: ${error.message}`);
      }

      throw error;
    }
  }

  // 抽象方法：由具体工作流实现业务逻辑
  abstract run(
    event: WorkflowEvent<TParams>,
    step: WorkflowStep,
  ): Promise<void>;
}