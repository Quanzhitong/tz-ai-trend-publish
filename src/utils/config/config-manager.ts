import { log } from "node:console";
import { IConfigSource } from "./interfaces/config-source.interface.ts";
import { DbConfigSource } from "./sources/db-config.source.ts";
import { EnvConfigSource } from "./sources/env-config.source.ts";
import { Logger } from "@zilla/logger";

const logger = new Logger("ConfigManager");

// 自定义配置错误类
export class ConfigurationError extends Error {
  constructor(message: string) {
    super(message);
    this.name = "ConfigurationError";  // 设置错误类型标识
  }
}

// 重试机制配置接口
interface RetryOptions {
  maxAttempts: number;  // 最大尝试次数
  delayMs: number;      // 重试间隔(毫秒)
}

/**
 * 配置管理器 - 实现多源配置的统一访问
 * 支持优先级排序、失败重试和动态源管理
 */
export class ConfigManager {
  // 单例实例
  private static instance: ConfigManager;
  
  // 配置源集合（按优先级排序）
  private configSources: IConfigSource[] = [];
  
  // 默认重试策略
  private defaultRetryOptions: RetryOptions = {
    maxAttempts: 3,   // 默认尝试3次
    delayMs: 1000,    // 默认间隔1秒
  };

  // 私有构造函数，只能在当前类中使用，外部不能再实例化，严格保证全局配置唯一实例化
  private constructor() {}

  /**
   * 获取单例实例，用闭包实现代码会更简单
   * @returns ConfigManager唯一实例
   */
  public static getInstance(): ConfigManager {
    if (!ConfigManager.instance) {
      // 初次实例化
      ConfigManager.instance = new ConfigManager();
    }
    return ConfigManager.instance;
  }

  /**
   * 添加配置源并自动排序
   * @param source 配置源实例
   */
  public addSource(source: IConfigSource): void {
    this.configSources.push(source);
    // 按优先级升序排序（数字越小优先级越高）
    this.configSources.sort((a, b) => a.priority - b.priority);
  }

  // 延迟函数（用于重试间隔）
  private async delay(ms: number): Promise<void> {
    return new Promise((resolve) => setTimeout(resolve, ms));
  }

  /**
   * 带重试机制的配置获取
   * @param source 目标配置源
   * @param key 配置键
   * @param options 重试策略
   * @returns 配置值或null（失败时）
   */
  private async getWithRetry<T>(
    source: IConfigSource,
    key: string,
    options: RetryOptions,
  ): Promise<T | null> {
    let lastError: Error | null = null;

    for (let attempt = 1; attempt <= options.maxAttempts; attempt++) {
      try {
        // 尝试从源获取配置
        const value = await source.get<T>(key);
        // 成功立即返回
        return value;
      } catch (error) {
        lastError = error as Error;
        // 非最后一次尝试时等待
        if (attempt < options.maxAttempts) {
          // await 关键字确保延迟操作完成后再继续
          await this.delay(options.delayMs);
        }
      }
    }

    // 所有尝试失败后记录警告
    logger.warn(
      `配置键 "${key}" 获取失败（${options.maxAttempts}次尝试）。最后错误: ${lastError?.message}`,
    );
    return null;
  }

  /**
   * 初始化默认配置源（环境变量 + 可选数据库）
   */
  public async initDefaultConfigSources(): Promise<void> {
    // 1. 添加环境变量源（默认存在）
    this.addSource(new EnvConfigSource());
    
    // 2. 动态添加数据库源（如果启用）
    if (await this.get<boolean>("ENABLE_DB")) {
      logger.info("检测到数据库配置启用");
      this.addSource(new DbConfigSource());
    }
  }

  /**
   * 获取配置值（核心方法）
   * @param key 配置键（包括环境变量的配置和数据库配置）
   * @param retryOptions 可选重试策略
   * @returns 配置值
   * @throws {ConfigurationError} 所有源均失败时抛出
   */
  public async get<T>(
    key: string,
    retryOptions?: Partial<RetryOptions>,
  ): Promise<T> {
    // 合并自定义重试选项和默认值
    const options = { ...this.defaultRetryOptions, ...retryOptions };

    // 按优先级顺序遍历所有配置源
    for (const source of this.configSources) {
      const value = await this.getWithRetry<T>(source, key, options);
      
      // 成功获取值时立即返回
      if (value !== null) {
        return value;
      }
    }

    // 所有源均失败时抛出错误
    throw new ConfigurationError(
      `配置键 "${key}" 在所有源中均未找到（${options.maxAttempts}次尝试）`,
    );
  }

  /**
   * 获取当前所有配置源（副本）
   */
  public getSources(): IConfigSource[] {
    return [...this.configSources];  // 返回拷贝防止外部修改
  }

  /**
   * 清空所有配置源
   */
  public clearSources(): void {
    this.configSources = [];
  }
}