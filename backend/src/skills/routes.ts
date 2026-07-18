import type { FastifyInstance } from 'fastify';
import type { Capability, Provider } from '../providers/types.js';
import { inspectLocalSkill, installLocalSkill, previewLocalSkillTranslation, type LocalizationChoice } from './local-installer.js';
import { listStoredSkills, saveSkill, SkillStorageError } from './storage.js';
import type { SkillDefinition } from './types.js';

export interface SkillRouteDeps { getProvider: (capability: Capability) => Provider; }

export function createSkillRoutes(deps: SkillRouteDeps) {
  return async function skillRoutes(app: FastifyInstance): Promise<void> {
    app.get('/api/skills', async () => ({ skills: await listStoredSkills() }));

    app.post('/api/skills', async (req, reply) => {
      try {
        const skill = await saveSkill(req.body);
        return { ok: true, skill };
      } catch (err) {
        const message = err instanceof Error ? err.message : '保存技能失败';
        reply.code(
          err instanceof SkillStorageError && err.code === 'already_exists' ? 409 : 400,
        );
        return { ok: false, message };
      }
    });

    app.post('/api/skills/inspect-local', async (req, reply) => {
      const body = req.body as { sourceDir?: unknown };
      try { return { ok: true, inspection: await inspectLocalSkill(String(body?.sourceDir ?? '')) }; }
      catch (err) { reply.code(400); return { ok: false, message: err instanceof Error ? err.message : '读取技能失败' }; }
    });
    app.post('/api/skills/preview-translation', async (req) => {
      const body = req.body as { sourceDir?: unknown };
      let provider: Pick<Provider, 'chatStream'> | undefined;
      try { provider = deps.getProvider('chat'); } catch { provider = undefined; }
      return previewLocalSkillTranslation({ sourceDir: String(body?.sourceDir ?? ''), provider });
    });
    app.post('/api/skills/install-local', async (req, reply) => {
      const body = req.body as { sourceDir?: unknown; choice?: LocalizationChoice };
      if (!body?.choice) { reply.code(400); return { ok: false, message: '请选择中文信息处理方式' }; }
      return installLocalSkill({ sourceDir: String(body.sourceDir ?? ''), choice: body.choice });
    });
  };
}

export const skillRoutes = createSkillRoutes({ getProvider: () => { throw new Error('Provider not configured'); } });

export type { SkillDefinition };
