// TODO(wave0d/notify-cleanup): remove when electron/notify/sinks/* (Wave 0c #217)
// migrates to daemon or is replaced by Connect-RPC subscriptions from the renderer.
// Re-export shim — real implementation lives in packages/daemon/src/notify/badgeLabel.ts.
export * from '../../packages/daemon/src/notify/badgeLabel';
