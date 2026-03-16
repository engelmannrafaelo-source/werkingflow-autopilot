export interface ContentBlock {
  type: string;
  text?: string;
  name?: string;
  id?: string;
  input?: Record<string, unknown>;
}

export interface Message {
  role: 'user' | 'assistant' | 'system' | 'rate_limit' | 'api_error';
  content: string | ContentBlock[];
  timestamp?: string;
}

export interface Permission {
  id: string;
  type: string;
  toolName?: string;
  title?: string;
  toolInput?: Record<string, unknown>;
}

export interface PromptTemplate {
  id: string;
  label: string;
  message: string;
  category: "reply" | "start";
  subject?: string;
  order: number;
  createdAt: string;
}
