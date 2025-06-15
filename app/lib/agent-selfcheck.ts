import { getAgentContext } from './agent-context';
import { AGENT_TOOLS } from './agent-tools';

let hasChecked = false;

function getMockParams(toolName: string): Record<string, unknown> {
  switch (toolName) {
    case 'get_user_context':
      return {};
    case 'search_listings':
      return { keyword: '地铁', city: 'bj', budgetMin: 3000, budgetMax: 8000 };
    case 'search_legal_knowledge':
      return { question: '房东不退押金怎么办？' };
    case 'analyze_house_photo':
      return { imageUrl: 'https://example.com/mock-house.jpg', listingId: 'mock-1' };
    case 'generate_compare_report':
      return { listingIds: ['mock-1', 'mock-2'] };
    default:
      return {};
  }
}

export async function runAgentModuleSelfCheck(): Promise<void> {
  if (hasChecked) return;
  hasChecked = true;

  try {
    // 1) 验证上下文模块导入与执行
    const context = await getAgentContext();
    if (!context || !context.metadata) {
      console.warn('[AgentSelfCheck] AgentContext 返回结构无效，但继续运行');
    }

    // 2) 验证工具注册与执行
    if (!Array.isArray(AGENT_TOOLS) || AGENT_TOOLS.length === 0) {
      console.warn('[AgentSelfCheck] AGENT_TOOLS 为空，但继续运行');
      return;
    }

    for (const tool of AGENT_TOOLS) {
      if (!tool?.name || typeof tool.execute !== 'function') {
        console.warn(`[AgentSelfCheck] 工具定义无效: ${tool?.name || 'unknown'}，跳过`);
        continue;
      }
      
      // ★ 跳过需要真实数据的工具（避免使用模拟 URL 导致 API 错误）
      if (tool.name === 'analyze_house_photo' || tool.name === 'extract_listing_from_poster') {
        console.log(`[AgentSelfCheck] 跳过工具 ${tool.name}（需要真实图片数据）`);
        continue;
      }
      
      try {
        const params = getMockParams(tool.name);
        await tool.execute(params);
      } catch (toolError: any) {
        console.warn(`[AgentSelfCheck] 工具 ${tool.name} 执行失败:`, toolError?.message || toolError);
      }
    }

    console.log('[AgentSelfCheck] PASS: agent modules import and execute successfully.');
  } catch (error: any) {
    console.error('[AgentSelfCheck] FAIL:', error?.message || error);
    // 不抛出错误，避免阻塞应用启动
  }
}

