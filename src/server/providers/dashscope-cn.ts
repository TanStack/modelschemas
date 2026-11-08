import { cachedDocs } from './model-facts.ts'
import { fetchText, sha256Text } from './types.ts'
import type { ProviderConfig } from './types.ts'
import {
  applyCnCardFacts,
  applyCnCatalog,
  applyCnTextFacts,
  cnPriceModels,
  DASHSCOPE_CN_MODELS,
  DASHSCOPE_CN_PRICES,
} from './dashscope-cn-docs.ts'
import type { CnDoc } from './dashscope-cn-docs.ts'

export const DASHSCOPE_CN_TEXT =
  'https://help.aliyun.com/zh/model-studio/text-generation-model.md'
export const DASHSCOPE_CN_FLASH =
  'https://help.aliyun.com/zh/model-studio/qwen-flash.md'
const EXPECTED_TITLES = [
  '模型调用价格',
  '选择模型',
  '文本生成与视觉理解',
  'qwen-flash',
] as const
const URLS = [
  DASHSCOPE_CN_PRICES,
  DASHSCOPE_CN_MODELS,
  DASHSCOPE_CN_TEXT,
  DASHSCOPE_CN_FLASH,
] as const
async function load(kv?: KVNamespace) {
  return cachedDocs(kv, DASHSCOPE_CN_PRICES, async () => {
    const docs = await Promise.all(
      URLS.map(async (url, index): Promise<CnDoc> => {
        const text = await fetchText(url, {
          signal: AbortSignal.timeout(30_000),
        })
        if (
          /<!doctype|<html\b/i.test(text) ||
          /^#\s+([^\r\n]+)/m.exec(text)?.[1]?.trim() !== EXPECTED_TITLES[index]
        )
          throw new Error(`dashscope-cn: malformed native source ${url}`)
        return { text, url, hash: await sha256Text(text) }
      }),
    )
    const [prices, catalog, textModels, flash] = docs
    if (!prices || !catalog || !textModels || !flash)
      throw new Error('dashscope-cn: missing native source')
    const models = applyCnCardFacts(
      applyCnTextFacts(
        applyCnCatalog(cnPriceModels(prices), catalog),
        textModels,
      ),
      flash,
    )
    return { docs, models }
  })
}
export const provider: ProviderConfig = {
  id: 'dashscope-cn',
  displayName: 'Alibaba Cloud Model Studio (China)',
  defaultDerivation: 'docs-derived',
  modelsEndpoint: DASHSCOPE_CN_MODELS,
  specSourceUrl: DASHSCOPE_CN_MODELS,
  bindSyncedRoutesOnly: true,
  async listModels(_env, kv) {
    return { models: (await load(kv)).models }
  },
  async fetchSpec() {
    const { docs } = await load()
    return {
      specs: [],
      sources: docs.map(({ url, hash }) => ({ url, hash })),
      outputStrategy: 'post-200',
      skipped:
        'dashscope-cn: native Beijing docs publish public model facts and RMB prices, but no sourced complete API body schema has been extracted — skipped',
    }
  },
  classify: () => null,
}
