import axios from "npm:axios";
import { LLMFactory } from "@src/providers/llm/llm-factory.ts";
import { LLMProvider } from "@src/providers/interfaces/llm.interface.ts";
import { RetryUtil } from "@src/utils/retry.util.ts";
import { Logger } from "@zilla/logger";

const logger = new Logger("livebench.api");

// 定义类别映射结构：键为类别名，值为指标名称数组
interface CategoryMapping {
  [key: string]: string[];
}

// 模型得分结构：键为指标名，值为分数
interface ModelScore {
  [key: string]: number;
}

// 指标集合结构：键为指标名，值为数值
interface Metrics {
  [key: string]: number;
}

// 模型性能数据接口（公开）
export interface ModelPerformance {
  metrics: Metrics;        // 计算后的各项指标
  organization: string;    // 模型所属组织
}

// 模型信息结构（内部使用）
interface ModelInfo {
  scores: ModelScore;      // 原始得分数据
  organization?: string;   // 模型所属组织（可选）
}

// 模型得分集合：键为模型名，值为模型信息
interface ModelScores {
  [modelName: string]: ModelInfo;
}

/** 
 * LiveBenchAPI 类 - 用于获取和分析AI模型性能数据
 * 提供模型性能查询、分类平均分计算和顶级模型排名功能
 */
export class LiveBenchAPI {
  private static readonly BASE_URL = "https://livebench.ai";  // API基础地址
  private categoryMapping: CategoryMapping = {};             // 存储类别-指标映射关系
  private llmProvider!: LLMProvider;                         // LLM提供者实例

  constructor() {
    this.refresh();  // 初始化时刷新LLM提供者
  }

  /** 刷新LLM提供者实例 */
  async refresh() {
    try {
      const llmFactory = LLMFactory.getInstance();
      // 获取指定提供者（此处固定使用"QWEN"）
      this.llmProvider = await llmFactory.getLLMProvider("QWEN");
      await this.llmProvider.refresh();  // 刷新提供者状态
    } catch (error) {
      console.error("刷新LLM提供者失败:", error);
      throw new Error(`无法刷新LLM提供者: ${(error as Error).message}`);
    }
  }

  /** 
   * 获取模型所属组织（带重试机制）
   * @param modelName - 要查询的模型名称
   * @returns 模型所属组织名称
   */
  private async getModelOrganization(modelName: string): Promise<string> {
    return RetryUtil.retryOperation(async () => {
      await this.refresh();  // 每次重试前刷新LLM提供者
      
      // 构造提示词和系统提示
      const prompt = `请搜索这个AI模型名称 "${modelName}" 属于哪个组织或公司。只需要返回组织名称 不要多余输出！！ 请联网搜索！！！！`;
      const systemPrompt = `...（系统提示内容省略）`; // 包含模型-组织映射参考数据
      
      // 调用LLM获取组织信息
      const response = await this.llmProvider.createChatCompletion([
        { role: "system", content: systemPrompt },
        { role: "user", content: prompt }
      ]);

      // 处理并验证响应
      const result = response.choices[0]?.message?.content;
      if (!result || typeof result !== "string") {
        console.warn(`Invalid response for model ${modelName}, returning Unknown`);
        return "Unknown";
      }

      return result.trim() || "Unknown";  // 返回清理后的结果
    }, {
      maxRetries: 3,                   // 最大重试次数
      baseDelay: 1000,                 // 基础延迟(ms)
      useExponentialBackoff: true      // 启用指数退避策略
    });
  }

  /** 从API获取类别映射数据 */
  private async fetchCategories(): Promise<void> {
    try {
      const response = await axios.get(
        `${LiveBenchAPI.BASE_URL}/categories_2024_11_25.json`  // liveBench 官方提供的固定数据
      );
      this.categoryMapping = response.data;  // 存储获取的映射数据
    } catch (error) {
      console.error("Error fetching categories:", error);
      throw new Error("Failed to fetch LiveBench categories");
    }
  }

  /** 
   * 获取模型得分数据（CSV格式）
   * @returns 包含所有模型得分数据的对象
   */
  private async fetchScores(): Promise<ModelScores> {
    try {
      const response = await axios.get(
        `${LiveBenchAPI.BASE_URL}/table_2024_11_25.csv`  // 得分数据端点
      );
      const rows = response.data.trim().split("\n");  // 分割CSV行
      const headers = rows[0].split(",");              // 提取表头
      const modelScores: ModelScores = {};            // 存储结果

      const totalRows = rows.length - 1;
      const concurrencyLimit = 10;  // 并发处理限制
      const allRows = rows.slice(1); // 跳过表头

      // 分批处理数据行
      for (let i = 0; i < allRows.length; i += concurrencyLimit) {
        const batch = allRows.slice(i, i + concurrencyLimit);
        
        // 并行处理当前批次
        await Promise.all(
          batch.map(async (row: string, batchIndex: number) => {
            const index = i + batchIndex;
            const values = row.split(",");
            const modelName = values[0];  // 首列为模型名
            const scores: ModelScore = {};

            // 解析每个指标的得分
            for (let j = 1; j < headers.length; j++) {
              const metric = headers[j];
              const score = parseFloat(values[j]);
              if (!isNaN(score)) scores[metric] = score;  // 忽略无效值
            }

            // 获取模型所属组织
            const organization = await this.getModelOrganization(modelName);
            modelScores[modelName] = { scores, organization };

            // 进度日志
            const progress = (((index + 1) / totalRows) * 100).toFixed(1);
            logger.info(`Processing models: ${progress}% (${index + 1}/${totalRows})`);
          })
        );
      }
      return modelScores;
    } catch (error) {
      console.error("Error fetching scores:", error);
      throw new Error("Failed to fetch LiveBench scores");
    }
  }

  /** 
   * 计算分类平均分和全局平均分
   * @param modelInfo - 模型原始数据
   * @param categories - 类别映射数据
   * @returns 包含计算后指标和组织信息的对象
   */
  private calculateCategoryAverages(
    modelInfo: ModelInfo,
    categories: CategoryMapping
  ): ModelPerformance {
    const metrics: Metrics = {};
    const scores = modelInfo.scores;

    // 计算每个类别的平均分
    for (const [category, categoryMetrics] of Object.entries(categories)) {
      // 过滤有效分数
      const validScores = categoryMetrics
        .map((metric) => scores[metric])
        .filter((score) => !isNaN(score));

      // 计算并存储类别平均分
      if (validScores.length > 0) {
        const sum = validScores.reduce((acc, score) => acc + score, 0);
        metrics[`${category} Average`] = Number((sum / validScores.length).toFixed(2));
      } else {
        metrics[`${category} Average`] = 0;  // 无有效分数时设为0
      }
    }

    // 计算全局平均分
    const allScores = Object.values(scores).filter((score) => !isNaN(score));
    if (allScores.length > 0) {
      const globalSum = allScores.reduce((acc, score) => acc + score, 0);
      metrics["Global Average"] = Number((globalSum / allScores.length).toFixed(2));
    } else {
      metrics["Global Average"] = 0;
    }

    return {
      metrics,
      organization: modelInfo.organization || "Unknown",  // 确保组织信息存在
    };
  }

  /** 
   * 获取模型性能数据
   * @param modelName - 可选，指定模型名则返回单模型数据，否则返回全部
   * @returns 模型性能数据集合
   */
  public async getModelPerformance(
    modelName?: string
  ): Promise<{ [key: string]: ModelPerformance }> {
    try {
      await this.fetchCategories();  // 先获取类别映射
      const modelScores = await this.fetchScores();  // 再获取得分数据
      const result: { [key: string]: ModelPerformance } = {};

      // 处理单个模型请求
      if (modelName) {
        if (modelScores[modelName]) {
          result[modelName] = this.calculateCategoryAverages(
            modelScores[modelName],
            this.categoryMapping
          );
        } else {
          throw new Error(`Model ${modelName} not found`);  // 模型不存在
        }
      } 
      // 处理全部模型请求
      else {
        for (const [model, scores] of Object.entries(modelScores)) {
          result[model] = this.calculateCategoryAverages(scores, this.categoryMapping);
        }
      }

      return result;
    } catch (error) {
      logger.error("Error in getModelPerformance:", error);
      throw error;
    }
  }

  /** 
   * 获取顶级模型排名
   * @param limit - 返回结果数量（默认5）
   * @param sortBy - 排序依据指标（默认"Global Average"）
   * @returns 按指定指标排序的顶级模型集合
   */
  public async getTopPerformers(
    limit: number = 5,
    sortBy: string = "Global Average"
  ): Promise<{ [key: string]: ModelPerformance }> {
    const allPerformance = await this.getModelPerformance();  // 获取全部数据

    // 排序并截取Top N
    const modelRankings = Object.entries(allPerformance)
      .map(([model, performance]) => ({
        model,
        performance,
        avgScore: performance.metrics[sortBy] || 0  // 处理无效指标
      }))
      .sort((a, b) => b.avgScore - a.avgScore)  // 降序排序
      .slice(0, limit);

    // 转换为结果格式
    const result: { [key: string]: ModelPerformance } = {};
    modelRankings.forEach(({ model, performance }) => {
      result[model] = performance;
    });

    return result;
  }
}