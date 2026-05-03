// TODO(wave0d/agent-cleanup): orphan re-export shim — no current consumer.
// Real implementation lives in packages/daemon/src/agent/read-default-model.ts.
// Safe to delete from electron/ when a consumer is rewired (or sooner).
export * from '../../packages/daemon/src/agent/read-default-model';
