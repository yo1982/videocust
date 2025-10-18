
export enum SessionStatus {
  IDLE = 'Idle',
  CONNECTING = 'Connecting...',
  CONNECTED = 'Connected',
  DISCONNECTED = 'Disconnected',
  ERROR = 'Error',
}

export interface TranscriptEntry {
  author: 'user' | 'agent';
  text: string;
}
