export type Role = 'innocent' | 'imposter';
export type GamePhase = 'lobby' | 'loading' | 'answering' | 'reveal' | 'discussion' | 'voting' | 'results';

export interface GameSettings {
  maxPlayers: number;
  answeringTime: number;
  revealTime: number;
  discussionTime: number;
  votingTime: number;
}

export interface Player {
  id: string;
  name: string;
  role?: Role | null;
  answer?: string | null;
  vote?: string | null;
  score: number;
  isReady: boolean;
  isHost: boolean;
  avatarColor: string;
}

export interface ChatMessage {
  id: string;
  senderId: string;
  senderName: string;
  text: string;
  color: string;
  timestamp: number;
  senderAvatar?: string;
}

export interface QuestionTheme {
  theme: string;
  innocentQuestion: string;
  imposterQuestion: string;
}

export interface GameState {
  roomId: string;
  players: Player[];
  phase: GamePhase;
  timer: number;
  settings: GameSettings;
  chatMessages: ChatMessage[];
  currentTheme?: QuestionTheme | null;
  winner?: Role | null;
  votedOutPlayerId?: string | null;
}

export interface ServerToClientEvents {
  gameStateUpdate: (state: GameState) => void;
  error: (message: string) => void;
}

export interface ClientToServerEvents {
  createRoom: (name: string, settings: GameSettings) => void;
  joinRoom: (name: string, roomId?: string) => void;
  updateSettings: (settings: GameSettings) => void;
  sendMessage: (text: string) => void;
  toggleReady: () => void;
  submitAnswer: (answer: string) => void;
  submitVote: (targetId: string) => void;
  playAgain: () => void;
}
