// Moved to @sendmast/audience so worker-sender can evaluate segments too.
// Re-exported here to keep existing imports (and the spec) working.
export {
  compileSegment,
  type CompiledSegment,
  type EventConstraint,
  type OrderConstraint,
} from '@sendmast/audience';
