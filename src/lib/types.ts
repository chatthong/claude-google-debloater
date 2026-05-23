export interface MessageHeaders {
  id: string;
  threadId: string;
  internalDate: string;
  labelIds: string[];
  headers: {
    from?: string;
    subject?: string;
    date?: string;
    listUnsubscribe?: string;
    listUnsubscribePost?: string;
    precedence?: string;
    xMailer?: string;
    replyTo?: string;
    authenticationResults?: string;
  };
}

export type Action =
  | "trash"
  | "keep"
  | "unsubscribe"
  | "archive"
  | "needs_review"
  | "unclear"
  | `label:${string}`;

export type Tier = "haiku" | "sonnet" | "opus";

export interface Decision {
  id: string;
  action: Action;
  confidence: number;
  reason: string;
  tier: Tier;
  decidedAt: string;
}

export interface GmailLabel {
  id: string;
  name: string;
  type: "system" | "user";
  messagesTotal?: number;
  messagesUnread?: number;
  threadsTotal?: number;
}
