// 导入定时任务控制器
import { startCronJobs } from "@src/controllers/cron.ts";

// 导入配置管理器（单例模式）
import { ConfigManager } from "@src/utils/config/config-manager.ts";

// 导入日志模块及其日志级别枚举
import { Logger, LogLevel } from "@zilla/logger";

// 导入服务器启动函数
import startServer from "@src/server.ts";

// 异步启动函数
async function bootstrap() {
  // 获取配置管理器的单例实例
  const configManager = ConfigManager.getInstance();
  
  // 初始化默认配置源（可能是文件、环境变量等）
  await configManager.initDefaultConfigSources();

  // 设置全局日志级别为 INFO（只记录INFO及以上的日志）
  Logger.level = LogLevel.INFO;

  // 启动定时任务（如定时数据抓取、清理等）
  startCronJobs();
  
  // 启动主服务器（可能是HTTP/WebSocket服务）
  startServer();
}

// 执行启动函数并捕获可能的错误
bootstrap().catch(console.error);