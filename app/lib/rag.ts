import { Asset } from 'expo-asset';

type KBFile = {
  filename: string;
  moduleRef: number;
};

type KBChunk = {
  id: string;
  source: string;
  content: string;
  keywords: string[];
  embedding?: number[];
};

export type LegalKBHit = {
  source: string;
  snippet: string;
  score: number;
};

const LEGAL_KEYWORDS = [
  '合同', '押金', '纠纷', '违约', '维权', '中介', '退租', '赔偿',
  '避坑', '陷阱', '看房清单', '看房注意', '租房注意', '合同注意', '合同条款',
  '签合同', '押金退', '不退押金', '扣押金', '解约', '霸王条款', '转租',
  '提前退租', '民法典', '诉讼', '调解', '起诉房东', '投诉', '维权途径',
  '法律', '权益', '房东', '中介费', '违规', '产权', '证件', '房本',
];

const KB_FILES: KBFile[] = [
  // eslint-disable-next-line @typescript-eslint/no-require-imports
  { filename: 'rentlaw-civil-code.md', moduleRef: require('../../assets/legal-kb/rentlaw-civil-code.md') },
  // eslint-disable-next-line @typescript-eslint/no-require-imports
  { filename: 'deposit-disputes.md', moduleRef: require('../../assets/legal-kb/deposit-disputes.md') },
  // eslint-disable-next-line @typescript-eslint/no-require-imports
  { filename: 'contract-traps.md', moduleRef: require('../../assets/legal-kb/contract-traps.md') },
  // eslint-disable-next-line @typescript-eslint/no-require-imports
  { filename: 'tenant-rights.md', moduleRef: require('../../assets/legal-kb/tenant-rights.md') },
];

let initialized = false;
let chunks: KBChunk[] = [];
let embeddingReady = false;
let featureExtractor: any = null;

function tokenize(text: string): string[] {
  const normalized = text.toLowerCase();
  const zhTokens = normalized.match(/[\u4e00-\u9fa5]{1,6}/g) || [];
  const enTokens = normalized.match(/[a-z0-9_]{2,}/g) || [];
  return [...zhTokens, ...enTokens];
}

function splitIntoChunks(source: string, raw: string): KBChunk[] {
  const blocks = raw
    .split(/\n{2,}/)
    .map((b) => b.trim())
    .filter((b) => b.length >= 20);

  const out: KBChunk[] = [];
  let idx = 0;
  for (const block of blocks) {
    const text = block.replace(/\s+/g, ' ').trim();
    if (!text) continue;
    const limited = text.length > 320 ? `${text.slice(0, 320)}...` : text;
    out.push({
      id: `${source}-${idx++}`,
      source,
      content: limited,
      keywords: tokenize(limited),
    });
  }
  return out;
}

async function readAssetText(moduleRef: number): Promise<string> {
  const asset = Asset.fromModule(moduleRef);
  await asset.downloadAsync();
  const uri = asset.localUri || asset.uri;
  const res = await fetch(uri);
  return await res.text();
}

async function ensureEmbeddingModel(): Promise<boolean> {
  if (featureExtractor) return true;
  try {
    // 在 React Native 环境中，transformers 库可能不可用，直接返回 false 使用关键词检索
    if (typeof window !== 'undefined' && !window.document) {
      console.log('[RAG] Running in React Native, using keyword-only retrieval.');
      return false;
    }
    const { pipeline, env } = await import('@xenova/transformers');
    env.allowRemoteModels = true;
    env.useBrowserCache = true;
    featureExtractor = await pipeline('feature-extraction', 'Xenova/all-MiniLM-L6-v2');
    return true;
  } catch (error) {
    console.warn('[RAG] Embedding model unavailable, fallback to keyword retrieval.', error);
    return false;
  }
}

async function embedText(text: string): Promise<number[] | null> {
  if (!featureExtractor) return null;
  try {
    const output = await featureExtractor(text, { pooling: 'mean', normalize: true });
    const data: number[] = Array.from(output?.data || []);
    return data.length ? data : null;
  } catch {
    return null;
  }
}

function dot(a?: number[], b?: number[]): number {
  if (!a || !b || a.length !== b.length) return 0;
  let score = 0;
  for (let i = 0; i < a.length; i++) score += a[i] * b[i];
  return score;
}

function keywordScore(queryTokens: string[], chunkTokens: string[]): number {
  if (!queryTokens.length) return 0;
  const set = new Set(chunkTokens);
  let hit = 0;
  for (const token of queryTokens) {
    if (set.has(token)) hit += 1;
  }
  return hit / queryTokens.length;
}

export async function initRAG(): Promise<void> {
  if (initialized) return;
  
  try {
    // #region agent log
    fetch('http://127.0.0.1:7750/ingest/c7852349-c1c4-418e-b862-f082a33bb43e',{method:'POST',headers:{'Content-Type':'application/json','X-Debug-Session-Id':'50dec4'},body:JSON.stringify({sessionId:'50dec4',runId:'initial',hypothesisId:'H3',location:'app/lib/rag.ts:122',message:'initRAG entered',data:{kbCount:KB_FILES.length},timestamp:Date.now()})}).catch(()=>{});
    // #endregion

    const loadedTexts = await Promise.all(
      KB_FILES.map(async (file) => {
        try {
          const text = await readAssetText(file.moduleRef);
          return { filename: file.filename, text };
        } catch (error) {
          console.warn(`[RAG] Failed to load ${file.filename}:`, error);
          return { filename: file.filename, text: '' };
        }
      })
    );

    chunks = loadedTexts.flatMap((item) => item.text ? splitIntoChunks(item.filename, item.text) : []);

    // 在移动端环境中跳过 embedding 模型加载，直接使用关键词检索
    const canEmbed = await ensureEmbeddingModel();
    if (canEmbed) {
      const vectors = await Promise.all(chunks.map((c) => embedText(c.content)));
      chunks = chunks.map((chunk, i) => ({ ...chunk, embedding: vectors[i] || undefined }));
      embeddingReady = vectors.some(Boolean);
    } else {
      embeddingReady = false;
    }

    initialized = true;
    // #region agent log
    fetch('http://127.0.0.1:7750/ingest/c7852349-c1c4-418e-b862-f082a33bb43e',{method:'POST',headers:{'Content-Type':'application/json','X-Debug-Session-Id':'50dec4'},body:JSON.stringify({sessionId:'50dec4',runId:'initial',hypothesisId:'H3',location:'app/lib/rag.ts:145',message:'initRAG completed',data:{chunkCount:chunks.length,embeddingReady},timestamp:Date.now()})}).catch(()=>{});
    // #endregion
    console.log(`[RAG] Initialized with ${chunks.length} chunks. embeddingReady=${embeddingReady}`);
  } catch (error) {
    console.error('[RAG] initRAG failed:', error);
    // 即使初始化失败，也标记为已初始化，避免重复尝试导致崩溃
    initialized = true;
    chunks = [];
    embeddingReady = false;
  }
}

export function isLegalQuestion(text: string): boolean {
  const normalized = text.trim();
  if (!normalized) return false;
  return LEGAL_KEYWORDS.some((kw) => normalized.includes(kw));
}

export async function searchLegalKB(query: string): Promise<LegalKBHit[]> {
  if (!initialized) {
    await initRAG();
  }

  const q = query.trim();
  if (!q) return [];

  const qTokens = tokenize(q);
  const qEmbedding = embeddingReady ? await embedText(q) : null;

  const ranked = chunks
    .map((chunk) => {
      const kScore = keywordScore(qTokens, chunk.keywords);
      const sScore = qEmbedding && chunk.embedding ? Math.max(0, dot(qEmbedding, chunk.embedding)) : 0;
      const score = embeddingReady ? (kScore * 0.45 + sScore * 0.55) : kScore;
      return { chunk, score };
    })
    .sort((a, b) => b.score - a.score)
    .slice(0, 3)
    .map(({ chunk, score }) => ({
      source: chunk.source,
      snippet: chunk.content,
      score: Number(score.toFixed(4)),
    }));

  return ranked;
}

export async function runRAGSelfCheck(): Promise<void> {
  try {
    await initRAG();

    const legalQuery = '房东不退押金，我应该怎么维权？';
    const nonLegalQuery = '推荐几个北京通勤方便的小区';

    const legalDetected = isLegalQuestion(legalQuery);
    const nonLegalDetected = isLegalQuestion(nonLegalQuery);
    if (!legalDetected) {
      throw new Error('isLegalQuestion 对法律问题识别失败');
    }
    if (nonLegalDetected) {
      throw new Error('isLegalQuestion 对非法律问题误判');
    }

    const hits = await searchLegalKB(legalQuery);
    if (!Array.isArray(hits) || hits.length === 0) {
      throw new Error('searchLegalKB 未返回有效检索结果');
    }

    const valid = hits.every((item) => item.source && item.snippet && typeof item.score === 'number');
    if (!valid) {
      throw new Error('searchLegalKB 返回结构不完整');
    }

    console.log(`[RAGSelfCheck] PASS: ${hits.length} hits returned for legal query.`);
  } catch (error: any) {
    console.error('[RAGSelfCheck] FAIL:', error?.message || error);
  }
}

