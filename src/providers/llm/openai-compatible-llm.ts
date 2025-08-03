import { ConfigManager } from "@src/utils/config/config-manager.ts";
import { HttpClient } from "@src/utils/http/http-client.ts";
import {
  ChatCompletionOptions,
  ChatMessage,
  LLMProvider, // 大型语言模型提供者接口
} from "@src/providers/interfaces/llm.interface.ts";

/**
 * OpenAI兼容的大型语言模型（LLM）的provider实现
 * 支持多种OpenAI兼容的API服务（如OpenAI、Deepseek、QWen等）
 */
export class OpenAICompatibleLLM implements LLMProvider {
  private baseURL!: string; // API基础URL
  private token!: string; // API认证令牌
  private defaultModel!: string; // 默认使用的模型
  private availableModels: string[] = []; // 可用模型列表
  private httpClient: HttpClient; // HTTP客户端实例

  /**
   * 构造函数
   * @param configKeyPrefix 配置键前缀（用于区分不同提供者）
   * @param configManager 配置管理器实例
   * @param specifiedModel 指定使用的模型（可选）
   */
  constructor(
    private configKeyPrefix: string = "", // 配置键前缀
    private configManager: ConfigManager = ConfigManager.getInstance(), // 配置管理器
    private specifiedModel?: string, // 可选指定的模型
  ) {
    this.httpClient = HttpClient.getInstance(); // 获取HTTP客户端单例
  }

  /**
   * 初始化LLM提供者
   */
  async initialize(): Promise<void> {
    await this.refresh(); 
  }

  /**
   * 刷新配置（从配置管理器加载最新配置）
   */
  async refresh(): Promise<void> {
    // 从配置管理器获取API基础URL
    this.baseURL = await this.configManager.get(
      `${this.configKeyPrefix}BASE_URL`,
    );
    
    // 从配置管理器获取API认证令牌
    this.token = await this.configManager.get(`${this.configKeyPrefix}API_KEY`);

    // 获取模型配置（支持多模型格式 "model1|model2|model3"）
    const modelConfig =
      await this.configManager.get(`${this.configKeyPrefix}MODEL`) ||
      "gpt-3.5-turbo"; // 默认模型
    
    // 处理模型配置字符串，分割为数组
    this.availableModels = (modelConfig as string).split("|").map((
      model: string,
    ) => model.trim());

    // 如果指定了特定模型，使用指定的模型，否则使用第一个可用模型
    this.defaultModel = this.specifiedModel || this.availableModels[0];

    // 验证基础URL是否配置
    if (!this.baseURL) {
      throw new Error(`${this.configKeyPrefix}BASE_URL is not set`);
    }
    
    // 验证API令牌是否配置
    if (!this.token) {
      throw new Error(`${this.configKeyPrefix}API_KEY is not set`);
    }

    // 检查API服务是否可用（健康检查）
    const isHealthy = await this.httpClient.healthCheck(this.baseURL);
    if (!isHealthy) {
      console.warn(
        `警告: LLM服务 ${this.baseURL} 健康检查失败，可能无法正常访问`,
      );
    }
  }

  /**
   * 设置当前使用的模型
   * @param model 模型名称
   */
  public setModel(model: string): void {
    // 检查请求的模型是否在可用模型列表中
    if (this.availableModels.includes(model)) {
      this.defaultModel = model; // 设置新模型
    } else {
      // 模型不可用时发出警告
      console.warn(
        `警告: 模型 ${model} 不在可用模型列表中，将使用默认模型 ${this.defaultModel}`,
      );
    }
  }

  /**
   * 获取当前使用的模型
   * @returns 当前模型名称
   */
  public getModel(): string {
    return this.defaultModel;
  }

  /**
   * 获取所有可用的模型
   * @returns 可用模型列表的副本
   */
  public getAvailableModels(): string[] {
    return [...this.availableModels]; // 返回副本以防止外部修改
  }

  /**
   * 创建聊天补全（核心API调用）
   * @param messages 聊天消息数组
   * @param options 聊天补全选项
   * @returns API响应
   */
  async createChatCompletion(
    messages: ChatMessage[], // 聊天消息历史
    options: ChatCompletionOptions = {}, // 选项参数（可选）
  ): Promise<any> {
    try {
      // 使用HttpClient发送API请求（自动处理重试和超时）
      return await this.httpClient.request(`${this.baseURL}/chat/completions`, {
        method: "POST",
        headers: {
          "Content-Type": "application/json",
          "Authorization": `Bearer ${this.token}`, // Bearer认证
        },
        body: JSON.stringify({
          model: options.model || this.defaultModel, // 使用选项中的模型或默认模型
          messages, // 聊天消息历史
          temperature: options.temperature ?? 0.7, // 温度参数（控制随机性）
          top_p: options.top_p ?? 1, // 核心采样参数
          max_tokens: options.max_tokens ?? 2000, // 最大生成长度
          stream: options.stream ?? false, // 是否流式响应
          response_format: options.response_format, // 响应格式（如JSON模式）
        }),
        timeout: 60000, // 60秒超时
        retries: 3, // 最多重试3次
        retryDelay: 10000, // 重试间隔1秒
      });
    } catch (error) {
      // 错误处理
      throw new Error(`创建聊天失败: ${(error as Error).message}`);
    }
  }
}