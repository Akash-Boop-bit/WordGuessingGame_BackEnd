import express from 'express';
import { createServer } from 'http';
import { Server } from 'socket.io';
import cors from 'cors';
import dotenv from 'dotenv';
import { GoogleGenerativeAI, SchemaType } from '@google/generative-ai';
import { 
  ClientToServerEvents, 
  ServerToClientEvents, 
  GameState, 
  Player, 
  GamePhase, 
  Role,
  QuestionTheme,
  GameSettings,
  ChatMessage
} from './types';
import { questionThemes } from './questions';

dotenv.config();

const app = express();
app.use(cors());

const httpServer = createServer(app);
const io = new Server<ClientToServerEvents, ServerToClientEvents>(httpServer, {
  cors: {
    origin: "*",
    methods: ["GET", "POST"]
  }
});

// Initialize Gemini
const apiKey = process.env.GEMINI_API_KEY || process.env.GOOGLE_API_KEY || '';
const genAI = new GoogleGenerativeAI(apiKey);
const model = genAI.getGenerativeModel({ model: 'gemini-flash-latest' });

if (!apiKey) {
  console.warn('WARNING: No Gemini API key found. Falling back to static questions.');
}

const COLORS = [
  '#ef4444', '#3b82f6', '#10b981', '#f59e0b', 
  '#8b5cf6', '#ec4899', '#06b6d4', '#84cc16'
];

// Multi-room state management
const rooms = new Map<string, GameState>();
const roomTimers = new Map<string, NodeJS.Timeout>();

const generateRoomCode = () => {
  return Math.random().toString(36).substring(2, 8).toUpperCase();
};

const broadcastState = (roomId: string) => {
  const room = rooms.get(roomId);
  if (room) {
    io.to(roomId).emit('gameStateUpdate', room);
  }
};

const startTimer = (roomId: string, seconds: number, callback: () => void) => {
  const room = rooms.get(roomId);
  if (!room) return;

  const existingTimer = roomTimers.get(roomId);
  if (existingTimer) clearInterval(existingTimer);

  room.timer = seconds;
  broadcastState(roomId);

  const timer = setInterval(() => {
    const r = rooms.get(roomId);
    if (!r) {
      clearInterval(timer);
      return;
    }

    r.timer--;
    if (r.timer <= 0) {
      clearInterval(timer);
      callback();
    }
    broadcastState(roomId);
  }, 1000);

  roomTimers.set(roomId, timer);
};

const generateAIQuestion = async (retryCount = 0): Promise<QuestionTheme> => {
  try {
    const prompt = `
      You are a game master for a social deduction game called "Imposter Word Game".
      Generate a single theme and two closely related questions for players.
      - Theme: A general category (e.g., "Breakfast", "Movies", "Animals").
      - Innocent Question: A question about a specific object or concept within the theme.
      - Imposter Question: A question about a DIFFERENT but VERY SIMILAR object or concept within the same theme.
      
      The goal is for both groups to answer with ONE WORD. Their answers should be similar enough that the imposter can blend in, but distinct enough that careful questioning can reveal them.

      Example:
      Theme: Pets
      Innocent Question: What is a furry pet that barks? (Answer: Dog)
      Imposter Question: What is a furry pet that meows? (Answer: Cat)
    `;

    const result = await model.generateContent({
      contents: [{ role: 'user', parts: [{ text: prompt }] }],
      generationConfig: {
        responseMimeType: 'application/json',
        responseSchema: {
          type: SchemaType.OBJECT,
          properties: {
            theme: { type: SchemaType.STRING },
            innocentQuestion: { type: SchemaType.STRING },
            imposterQuestion: { type: SchemaType.STRING },
          },
          required: ['theme', 'innocentQuestion', 'imposterQuestion'],
        },
      },
    });

    const response = await result.response;
    const text = response.text();
    return JSON.parse(text) as QuestionTheme;

  } catch (error: any) {
    const isRetryable = error.status === 503 || error.status === 429 || error.message?.includes('503') || error.message?.includes('429');
    if (isRetryable && retryCount < 3) {
      const delay = Math.pow(2, retryCount) * 1000;
      await new Promise(resolve => setTimeout(resolve, delay));
      return generateAIQuestion(retryCount + 1);
    }
    console.error('Error generating AI question:', error);
    return questionThemes[Math.floor(Math.random() * questionThemes.length)];
  }
};

const transitionToPhase = async (roomId: string, phase: GamePhase) => {
  const room = rooms.get(roomId);
  if (!room) return;

  room.phase = phase;

  if (phase === 'loading') {
    broadcastState(roomId);
    room.currentTheme = await generateAIQuestion();
    
    const imposterIndex = Math.floor(Math.random() * room.players.length);
    room.players.forEach((p, i) => {
      p.role = i === imposterIndex ? 'imposter' : 'innocent';
      p.answer = null;
      p.vote = null;
    });

    transitionToPhase(roomId, 'answering');
  } else if (phase === 'answering') {
    startTimer(roomId, room.settings.answeringTime, () => transitionToPhase(roomId, 'reveal'));
  } else if (phase === 'reveal') {
    startTimer(roomId, room.settings.revealTime, () => {
      if (room.settings.discussionTime > 0) {
        transitionToPhase(roomId, 'discussion');
      } else {
        transitionToPhase(roomId, 'voting');
      }
    });
  } else if (phase === 'discussion') {
    startTimer(roomId, room.settings.discussionTime, () => transitionToPhase(roomId, 'voting'));
  } else if (phase === 'voting') {
    startTimer(roomId, room.settings.votingTime, () => resolveVotes(roomId));
  }
  
  broadcastState(roomId);
};

const resolveVotes = (roomId: string) => {
  const room = rooms.get(roomId);
  if (!room) return;

  const voteCounts: Record<string, number> = {};
  room.players.forEach(p => {
    if (p.vote) {
      voteCounts[p.vote] = (voteCounts[p.vote] || 0) + 1;
    }
  });

  let maxVotes = 0;
  let votedOutId: string | null = null;
  
  Object.entries(voteCounts).forEach(([id, count]) => {
    if (count > maxVotes) {
      maxVotes = count;
      votedOutId = id;
    }
  });

  const votedPlayer = room.players.find(p => p.id === votedOutId);
  room.winner = votedPlayer?.role === 'imposter' ? 'innocent' : 'imposter';
  room.votedOutPlayerId = votedOutId;
  
  transitionToPhase(roomId, 'results');
};

io.on('connection', (socket) => {
  console.log('Player connected:', socket.id);

  socket.on('createRoom', (name, settings) => {
    const roomId = generateRoomCode();
    const newRoom: GameState = {
      roomId,
      players: [{
        id: socket.id,
        name,
        score: 0,
        isReady: false,
        isHost: true,
        avatarColor: COLORS[0]
      }],
      phase: 'lobby',
      timer: 0,
      settings,
      chatMessages: []
    };

    rooms.set(roomId, newRoom);
    socket.join(roomId);
    broadcastState(roomId);
  });

  socket.on('joinRoom', (name, roomId) => {
    if (!roomId) {
      const publicRoom = Array.from(rooms.values()).find(r => r.phase === 'lobby' && r.players.length < r.settings.maxPlayers);
      if (publicRoom) {
        roomId = publicRoom.roomId;
      } else {
        socket.emit('error', 'No public games found. Host one!');
        return;
      }
    }

    const room = rooms.get(roomId);
    if (!room) {
      socket.emit('error', 'Room not found!');
      return;
    }

    if (room.phase !== 'lobby') {
      socket.emit('error', 'Game already in progress!');
      return;
    }

    if (room.players.length >= room.settings.maxPlayers) {
      socket.emit('error', 'Room is full!');
      return;
    }

    const newPlayer: Player = {
      id: socket.id,
      name,
      score: 0,
      isReady: false,
      isHost: false,
      avatarColor: COLORS[room.players.length % COLORS.length]
    };

    room.players.push(newPlayer);
    socket.join(roomId);
    broadcastState(roomId);
  });

  socket.on('updateSettings', (settings) => {
    const roomId = Array.from(socket.rooms).find(r => r !== socket.id);
    if (!roomId) return;
    const room = rooms.get(roomId);
    if (room?.phase === 'lobby' && room.players.find(p => p.id === socket.id)?.isHost) {
      room.settings = settings;
      broadcastState(roomId);
    }
  });

  socket.on('sendMessage', (text) => {
    const roomId = Array.from(socket.rooms).find(r => r !== socket.id);
    if (!roomId) return;
    const room = rooms.get(roomId);
    if (!room) return;
    
    const player = room.players.find(p => p.id === socket.id);
    if (!player) return;

    const newMessage: ChatMessage = {
      id: Math.random().toString(36).substring(2, 9),
      senderId: socket.id,
      senderName: player.name,
      text,
      color: player.avatarColor,
      timestamp: Date.now()
    };

    room.chatMessages.push(newMessage);
    if (room.chatMessages.length > 50) {
      room.chatMessages.shift();
    }
    broadcastState(roomId);
  });

  socket.on('toggleReady', () => {
    const roomId = Array.from(socket.rooms).find(r => r !== socket.id);
    if (!roomId) return;
    const room = rooms.get(roomId);
    if (room && room.phase === 'lobby') {
      const player = room.players.find(p => p.id === socket.id);
      if (player) {
        player.isReady = !player.isReady;
        
        const allReady = room.players.length >= 4 && room.players.every(p => p.isReady);
        if (allReady) {
          transitionToPhase(roomId, 'loading');
        } else {
          broadcastState(roomId);
        }
      }
    }
  });

  socket.on('submitAnswer', (answer) => {
    const roomId = Array.from(socket.rooms).find(r => r !== socket.id);
    if (!roomId) return;
    const room = rooms.get(roomId);
    if (room && room.phase === 'answering') {
      const player = room.players.find(p => p.id === socket.id);
      if (player) {
        player.answer = answer;
        if (room.players.every(p => p.answer)) {
          transitionToPhase(roomId, 'reveal');
        } else {
          broadcastState(roomId);
        }
      }
    }
  });

  socket.on('submitVote', (targetId) => {
    const roomId = Array.from(socket.rooms).find(r => r !== socket.id);
    if (!roomId) return;
    const room = rooms.get(roomId);
    if (room && room.phase === 'voting' && socket.id !== targetId) {
      const player = room.players.find(p => p.id === socket.id);
      if (player) {
        player.vote = targetId;
        if (room.players.every(p => p.vote)) {
          resolveVotes(roomId);
        } else {
          broadcastState(roomId);
        }
      }
    }
  });

  socket.on('playAgain', () => {
    const roomId = Array.from(socket.rooms).find(r => r !== socket.id);
    if (!roomId) return;
    const room = rooms.get(roomId);
    if (room?.players.find(p => p.id === socket.id)?.isHost) {
      // Clear active timers
      const existingTimer = roomTimers.get(roomId);
      if (existingTimer) {
        clearInterval(existingTimer);
        roomTimers.delete(roomId);
      }

      room.phase = 'lobby';
      room.timer = 0;
      room.winner = null;
      room.votedOutPlayerId = null;
      room.currentTheme = null;
      room.chatMessages = [];
      room.players.forEach(p => {
        p.isReady = false;
        p.answer = null;
        p.vote = null;
      });
      broadcastState(roomId);
    }
  });

  socket.on('disconnecting', () => {
    socket.rooms.forEach(roomId => {
      if (roomId !== socket.id) {
        const room = rooms.get(roomId);
        if (room) {
          room.players = room.players.filter(p => p.id !== socket.id);
          if (room.players.length === 0) {
            const timer = roomTimers.get(roomId);
            if (timer) clearInterval(timer);
            roomTimers.delete(roomId);
            rooms.delete(roomId);
          } else {
            if (!room.players.some(p => p.isHost)) {
              room.players[0].isHost = true;
            }
            broadcastState(roomId);
          }
        }
      }
    });
  });
});

const PORT = process.env.PORT || 3001;
httpServer.listen(PORT, () => {
  console.log(`Server running on port ${PORT}`);
});
