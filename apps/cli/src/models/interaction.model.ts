// The port through which the session host talks to its front end (terminal UI):
// approvals, questions, events and notices.

import type { ExaEvent, PermissionReply, PermissionRequest } from "@exa/protocol";
import type { QuestionPort } from "@exa/tools";

export interface Interaction {
  approve(req: PermissionRequest, signal: AbortSignal): Promise<PermissionReply | null>;
  ask: QuestionPort["ask"];
  onEvent(e: ExaEvent): void;
  notice(msg: string): void;
}
