import { Router } from 'express';
import { accountOf } from '../auth.js';
import { GlobalSkillError, globalSkillInputSchema } from './globalStore.js';
import type { GlobalSkillService } from './global.js';

/** Mounted behind Vibe's auth middleware; ownership is never accepted from input. */
export function createGlobalSkillRouter(service: GlobalSkillService): Router {
  const router = Router();
  router.get('/', (req, res, next) => {
    try { res.json({ skills: service.list(accountOf(req).name) }); } catch (error) { next(error); }
  });
  router.get('/:id', (req, res, next) => {
    try {
      const skill = service.detail(accountOf(req).name, req.params.id);
      if (!skill) { res.status(404).json({ error: 'Global skill not found' }); return; }
      res.json({ skill });
    } catch (error) { next(error); }
  });
  router.post('/', (req, res, next) => {
    const input = globalSkillInputSchema.safeParse(req.body);
    if (!input.success) { res.status(400).json({ error: input.error.issues[0]?.message ?? 'Invalid global skill' }); return; }
    try {
      const skill = service.store.create(accountOf(req).name, input.data);
      service.kick();
      res.status(201).json({ skill: service.summary(skill) });
    } catch (error) { next(error); }
  });
  router.put('/:id', (req, res, next) => {
    const input = globalSkillInputSchema.safeParse(req.body);
    if (!input.success) { res.status(400).json({ error: input.error.issues[0]?.message ?? 'Invalid global skill' }); return; }
    try {
      const skill = service.store.update(accountOf(req).name, req.params.id, input.data);
      service.kick();
      res.json({ skill: service.summary(skill) });
    } catch (error) { next(error); }
  });
  router.post('/:id/retry', (req, res, next) => {
    try {
      service.store.retry(accountOf(req).name, req.params.id);
      service.kick();
      res.status(202).json({ ok: true });
    } catch (error) { next(error); }
  });
  router.delete('/:id', (req, res, next) => {
    try {
      if (!service.store.remove(accountOf(req).name, req.params.id)) { res.status(404).json({ error: 'Global skill not found' }); return; }
      res.json({ ok: true, nativeCopiesRetained: true });
    } catch (error) { next(error); }
  });
  router.use((error: unknown, _req: import('express').Request, res: import('express').Response, _next: import('express').NextFunction) => {
    const status = error instanceof GlobalSkillError ? error.status : 500;
    res.status(status).json({ error: error instanceof GlobalSkillError ? error.message : 'Global skill operation failed' });
  });
  return router;
}
