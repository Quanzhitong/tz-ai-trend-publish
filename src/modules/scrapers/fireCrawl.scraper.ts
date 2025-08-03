// 导入 Firecrawl SDK（通过 npm 模块）
import FirecrawlApp from "npm:firecrawl";
// 导入内容抓取相关接口和类型
import {
  ContentScraper,
  ScrapedContent,
  ScraperOptions,
} from "@src/modules/interfaces/scraper.interface.ts";
// 导入配置管理器
import { ConfigManager } from "@src/utils/config/config-manager.ts";
// 导入日期格式化工具
import { formatDate } from "@src/utils/common.ts";
// 导入 Zod 用于数据验证
import zod from "npm:zod";
// 导入日志工具
import { Logger } from "@zilla/logger";

// 创建日志实例
const logger = new Logger("fireCrawl-scraper");

// 使用 Zod 定义数据结构（确保从网页提取的数据符合预期格式）
// 接口格式校验，确保其符合预期格式
const StorySchema = zod.object({
  headline: zod.string(),       // 标题
  content: zod.string(),        // 内容
  link: zod.string(),           // 链接
  date_posted: zod.string(),    // 发布日期字符串
});

// 定义整个响应数据结构
const StoriesSchema = zod.object({
  stories: zod.array(StorySchema),  
});

// 实现内容抓取接口
export class FireCrawlScraper implements ContentScraper {
  private app!: FirecrawlApp;  // Firecrawl 应用实例

  // 初始化或刷新 Firecrawl 客户端
  async refresh(): Promise<void> {
    const startTime = Date.now();
    // 从配置管理器获取 API 密钥并初始化
    this.app = new FirecrawlApp({
      apiKey: await ConfigManager.getInstance().get("FIRE_CRAWL_API_KEY"),
    });
    logger.debug(`FireCrawlApp 初始化完成, 耗时: ${Date.now() - startTime}ms`);
  }

  // 为每个内容项生成唯一 ID（基于 URL 和时间戳）
  private generateId(url: string): string {
    const timestamp = Date.now();
    const random = Math.floor(Math.random() * 10000);
    // 计算 URL 的简单哈希值（用于唯一性）
    const urlHash = url.split("").reduce((acc, char) => {
      return ((acc << 5) - acc + char.charCodeAt(0)) | 0;
    }, 0);
    return `fc_${timestamp}_${random}_${Math.abs(urlHash)}`;
  }

  // 核心抓取方法
  async scrape(
    sourceId: string,       // 要抓取的源 URL
    options?: ScraperOptions // 可选参数（本实现未使用）
  ): Promise<ScrapedContent[]> {
    try {
      // 确保 Firecrawl 客户端已初始化
      await this.refresh();
      const startTime = Date.now();
      const currentDate = new Date().toLocaleDateString(); // 获取当前日期

      // 构建 LLM 提取提示词 - 核心指令：
      // 1. 只返回当天发布的 AI/LLM 相关内容
      // 2. 严格指定 JSON 格式
      // 3. 处理相对链接
      // 4. 翻译为中文
      const promptForFirecrawl = `
      Return only today's AI or LLM related story or post headlines and links in JSON format from the page content. 
      They must be posted today, ${currentDate}. The format should be:
        {
          "stories": [
            {
              "headline": "headline1",
              "content":"content1"
              "link": "link1",
              "date_posted": "YYYY-MM-DD HH:mm:ss",
            },
            ...
          ]
        }
      If there are no AI or LLM stories from today, return {"stories": []}.
      
      The source link is ${sourceId}. 
      If a story link is not absolute, prepend ${sourceId} to make it absolute. 
      Return only pure JSON in the specified format (no extra text, no markdown, no \\\\).  
      The content should be about 500 words, which can summarize the full text and the main point.
      Translate all into Chinese.
      !!
      `;

      // 使用 Firecrawl 的提取功能抓取网页内容
      const scrapeResult = await this.app.scrapeUrl(sourceId, {
        formats: ["extract"],  // 指定提取模式
        extract: {
          prompt: promptForFirecrawl,  // 注入提示词
          schema: StoriesSchema,        // 指定预期的数据结构
        },
      });

      // 检查抓取结果是否有效
      if (!scrapeResult.success || !scrapeResult.extract?.stories) {
        throw new Error(scrapeResult.error || "未获取到有效内容");
      }

      // 使用 Zod 验证数据结构是否符合预期
      const validatedData = StoriesSchema.parse(scrapeResult.extract);

      // 记录抓取统计信息
      logger.debug(
        `[FireCrawl] 从 ${sourceId} 获取到 ${validatedData.stories.length} 条内容 耗时: ${
          Date.now() - startTime
        }ms`,
      );
      
      // 将原始数据转换为 ScrapedContent 格式
      return validatedData.stories.map((story) => ({
        id: this.generateId(story.link),  // 生成唯一ID
        title: story.headline,            // 标题
        content: story.content,           // 内容（已按提示词要求处理）
        url: story.link,                  // URL
        publishDate: formatDate(story.date_posted), // 格式化日期
        score: 0,                         // 初始评分（后续可能计算）
        metadata: {                       // 原始元数据
          source: "fireCrawl",            // 来源标识
          originalUrl: story.link,        // 原始URL
          datePosted: story.date_posted,  // 原始日期字符串
        },
      }));
    } catch (error) {
      logger.error("FireCrawl抓取失败:", error);
      throw error;
    }
  }
}