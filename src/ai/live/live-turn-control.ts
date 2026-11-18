// No phrase classification here: the existing model/tool protocol identifies the operation.
export type LiveOperation = 'INTERPRETING' | 'READ' | 'DRAFT' | 'COMMIT';
export type LiveTurnControl = {
  isCurrent(): boolean;
  confirmationAllowed: boolean;
  onOperation(operation: LiveOperation): void;
  log?(
    event: string,
    fields: { queueDepth: number; pendingRevision: number | null },
  ): void;
};
