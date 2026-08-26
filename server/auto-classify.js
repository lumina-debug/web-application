import { AI_ENABLED } from './config.js';
import { classifyDocument } from './ai.js';
import { classifyByRules } from './classify.js';
import { isValidCategory } from './categories.js';

/**
 * 自動分類の入口。AIが使えればAIで、使えない・失敗したらルールベースで分類する。
 * どちらで分類したかは classifiedBy として資料に残す（後から見直せるように）。
 */
export async function autoClassify(input) {
  if (AI_ENABLED) {
    try {
      const result = await classifyDocument(input);
      if (isValidCategory(result.category)) {
        return { ...result, classifiedBy: 'ai' };
      }
    } catch (err) {
      console.warn('[classify] AI分類に失敗したためルールベースに切り替えます:', err.message);
    }
  }
  return { ...classifyByRules(input), classifiedBy: 'rule' };
}
