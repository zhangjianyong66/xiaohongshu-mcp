export type ToolCode =
  | "ok"
  | "login_required"
  | "platform_blocked"
  | "timeout"
  | "invalid_input"
  | "internal_error";

export type ToolResponse<T = unknown> = {
  success: boolean;
  code: ToolCode;
  message: string;
  data: T | null;
  meta?: Record<string, unknown>;
};

export class AppError extends Error {
  public readonly code: ToolCode;
  public readonly meta?: Record<string, unknown>;

  public constructor(code: ToolCode, message: string, meta?: Record<string, unknown>) {
    super(message);
    this.code = code;
    if (meta !== undefined) {
      this.meta = meta;
    }
  }
}

export type SearchFilters = {
  sort_by?: string;
  note_type?: string;
  publish_time?: string;
  search_scope?: string;
  location?: string;
};

export type FeedItem = {
  id?: string;
  modelType?: string;
  noteCard?: {
    displayTitle?: string;
    user?: {
      nickname?: string;
      userId?: string;
    };
    interactInfo?: {
      likedCount?: string | number;
      collectedCount?: string | number;
      commentCount?: string | number;
      shareCount?: string | number;
    };
    xsecToken?: string;
  };
};
