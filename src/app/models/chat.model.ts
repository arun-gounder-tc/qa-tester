export type ChatRole = 'user' | 'assistant' | 'system';

export interface ChatChoice {
  label: string;
  value: string;
}

export interface ChatMessage {
  id: string;
  role: ChatRole;
  content: string;
  choices?: ChatChoice[];
  timestamp: string;
}
