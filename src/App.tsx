import { useEffect, useMemo, useRef, useState } from 'react';
import {
  Globe,
  HelpCircle,
  LogOut,
  RotateCcw,
  Smartphone,
  Volume2,
  VolumeX,
  X,
} from 'lucide-react';
import { GAME_STEPS } from './types/game.ts';
import type {
  AnswersMap,
  Player,
  PlayMode,
  ScreenState,
  SentenceResult,
} from './types/game.ts';
import { buildSentences, createEmptyAnswers } from './utils/shuffler.ts';
import { soundFx } from './utils/sound.ts';
import { useMultiplayerRoom } from './hooks/useMultiplayerRoom.ts';
import { FourColumnBar } from './components/FourColumnBar.tsx';
import { LobbyScreen } from './components/LobbyScreen.tsx';
import { OnlineLobby } from './components/OnlineLobby.tsx';
import { PlayScreen } from './components/PlayScreen.tsx';
import { ShuffleScreen } from './components/ShuffleScreen.tsx';
import { ResultsScreen } from './components/ResultsScreen.tsx';
import { RoundSidebar } from './components/RoundSidebar.tsx';

function createPlayerId(): string {
  if (typeof crypto !== 'undefined' && typeof crypto.randomUUID === 'function') {
    return crypto.randomUUID();
  }
  return `${Date.now()}-${Math.random().toString(36).slice(2, 9)}`;
}

export default function App() {
  const initialQuery = useMemo(() => {
    if (typeof window === 'undefined') {
      return { roomCode: '', autostart: false };
    }
    const params = new URLSearchParams(window.location.search);
    return {
      roomCode: (params.get('room') ?? '').trim().toUpperCase(),
      autostart: params.get('autostart') === '1',
    };
  }, []);

  const [mode, setMode] = useState<PlayMode>(() =>
    initialQuery.autostart && !initialQuery.roomCode ? 'LOCAL' : 'ONLINE'
  );

  // Local pass-and-play state
  const [screen, setScreen] = useState<ScreenState>(() =>
    initialQuery.autostart && !initialQuery.roomCode ? 'PLAYING' : 'LOBBY'
  );
  const [players, setPlayers] = useState<Player[]>(() => [
    { id: createPlayerId(), name: '1. Kişi' },
    { id: createPlayerId(), name: '2. Kişi' },
  ]);
  const [currentStepIndex, setCurrentStepIndex] = useState(0);
  const [currentPlayerIndex, setCurrentPlayerIndex] = useState(0);
  const [inputText, setInputText] = useState('');
  const [isHiddenLocked, setIsHiddenLocked] = useState(false);
  const [answers, setAnswers] = useState<AnswersMap>(createEmptyAnswers);
  const [results, setResults] = useState<SentenceResult[]>([]);

  // Online multiplayer state
  const mp = useMultiplayerRoom(mode === 'ONLINE');
  const [onlineInputText, setOnlineInputText] = useState('');

  const [soundEnabled, setSoundEnabled] = useState(true);
  const [rulesOpen, setRulesOpen] = useState(false);

  const prevRoomScreenRef = useRef<ScreenState | null>(null);
  const prevRoomStepRef = useRef<number>(-1);

  // Clear online input when step or screen changes, and trigger sound cues
  useEffect(() => {
    if (!mp.room) {
      prevRoomScreenRef.current = null;
      prevRoomStepRef.current = -1;
      setOnlineInputText('');
      return;
    }

    const prevScreen = prevRoomScreenRef.current;
    const prevStep = prevRoomStepRef.current;

    if (
      prevScreen !== mp.room.screen ||
      prevStep !== mp.room.currentStepIndex
    ) {
      if (mp.room.screen === 'PLAYING') {
        setOnlineInputText('');
      }
      if (prevScreen && prevScreen !== mp.room.screen) {
        if (mp.room.screen === 'SHUFFLING') {
          soundFx.shuffle(soundEnabled);
        } else if (mp.room.screen === 'RESULTS') {
          soundFx.reveal(soundEnabled);
        }
      }
    }

    prevRoomScreenRef.current = mp.room.screen;
    prevRoomStepRef.current = mp.room.currentStepIndex;
  }, [mp.room, soundEnabled]);

  // Local mode: 850ms hidden-lock transition before advancing player or entering shuffle
  useEffect(() => {
    if (mode !== 'LOCAL' || screen !== 'PLAYING' || !isHiddenLocked) return;

    const timer = window.setTimeout(() => {
      setIsHiddenLocked(false);
      setInputText('');

      if (currentPlayerIndex + 1 < players.length) {
        setCurrentPlayerIndex((prev) => prev + 1);
      } else {
        soundFx.shuffle(soundEnabled);
        setScreen('SHUFFLING');
      }
    }, 850);

    return () => window.clearTimeout(timer);
  }, [mode, screen, isHiddenLocked, currentPlayerIndex, players.length, soundEnabled]);

  // Local mode: 1400ms shuffle screen before advancing step or revealing results
  useEffect(() => {
    if (mode !== 'LOCAL' || screen !== 'SHUFFLING') return;

    const timer = window.setTimeout(() => {
      if (currentStepIndex + 1 < GAME_STEPS.length) {
        setCurrentStepIndex((prev) => prev + 1);
        setCurrentPlayerIndex(0);
        setScreen('PLAYING');
      } else {
        const built = buildSentences(players, answers);
        setResults(built);
        soundFx.reveal(soundEnabled);
        setScreen('RESULTS');
      }
    }, 1400);

    return () => window.clearTimeout(timer);
  }, [mode, screen, currentStepIndex, players, answers, soundEnabled]);

  const handleAddPlayer = (name: string) => {
    const trimmed = name.trim();
    if (!trimmed) return;
    soundFx.tap(soundEnabled);
    setPlayers((prev) => [...prev, { id: createPlayerId(), name: trimmed }]);
  };

  const handleRenamePlayer = (id: string, name: string) => {
    setPlayers((prev) =>
      prev.map((p) => (p.id === id ? { ...p, name } : p))
    );
  };

  const handleRemovePlayer = (id: string) => {
    if (players.length <= 2) return;
    soundFx.tap(soundEnabled);
    setPlayers((prev) => prev.filter((p) => p.id !== id));
  };

  const handleStartGame = () => {
    const sanitizedPlayers = players.map((p, idx) => ({
      ...p,
      name: p.name.trim() || `${idx + 1}. Kişi`,
    }));

    soundFx.tap(soundEnabled);
    setPlayers(sanitizedPlayers);
    setAnswers(createEmptyAnswers());
    setCurrentStepIndex(0);
    setCurrentPlayerIndex(0);
    setInputText('');
    setIsHiddenLocked(false);
    setResults([]);
    setScreen('PLAYING');
  };

  const handleConfirmTick = () => {
    const trimmed = inputText.trim();
    if (!trimmed || isHiddenLocked) return;

    const activeStep = GAME_STEPS[currentStepIndex];
    const activePlayer = players[currentPlayerIndex];
    if (!activeStep || !activePlayer) return;

    soundFx.lock(soundEnabled);
    setAnswers((prev) => ({
      ...prev,
      [activeStep.key]: {
        ...prev[activeStep.key],
        [activePlayer.id]: trimmed,
      },
    }));
    setIsHiddenLocked(true);
  };

  const handleReshuffle = () => {
    soundFx.shuffle(soundEnabled);
    setResults(buildSentences(players, answers));
  };

  const handlePlayAgain = () => {
    soundFx.tap(soundEnabled);
    setIsHiddenLocked(false);
    setInputText('');
    setScreen('LOBBY');
  };

  const handleOnlineConfirm = () => {
    const trimmed = onlineInputText.trim();
    if (!trimmed) return;
    soundFx.lock(soundEnabled);
    mp.submitAnswer(trimmed);
  };

  const handleOnlineReshuffle = () => {
    soundFx.shuffle(soundEnabled);
    mp.reshuffle();
  };

  const handleOnlineReset = () => {
    soundFx.tap(soundEnabled);
    mp.resetToLobby();
  };

  const isOnline = mode === 'ONLINE';
  const onlineRoom = mp.room;
  const effectiveScreen: ScreenState = isOnline
    ? (onlineRoom?.screen ?? 'LOBBY')
    : screen;
  const effectiveStepIndex = isOnline
    ? (onlineRoom?.currentStepIndex ?? 0)
    : currentStepIndex;
  const activeStep = GAME_STEPS[effectiveStepIndex] ?? GAME_STEPS[0];

  const activeLocalPlayer = players[currentPlayerIndex] ?? players[0];
  const onlineSelfPlayer =
    onlineRoom?.players.find((p) => p.id === mp.myPlayerId) ??
    onlineRoom?.players[0];
  const onlineHasSubmitted = Boolean(
    onlineRoom &&
      mp.myPlayerId &&
      onlineRoom.submittedPlayerIds.includes(mp.myPlayerId)
  );
  const isOnlineHost = Boolean(
    onlineRoom && mp.myPlayerId && onlineRoom.hostId === mp.myPlayerId
  );

  return (
    <div
      className="min-h-screen bg-[#F6F7FB] text-[#0F172A] flex flex-col"
      data-game-mode={mode}
      data-game-screen={effectiveScreen}
    >
      <header className="border-b border-slate-200/80 bg-white">
        <div className="mx-auto flex h-14 max-w-5xl items-center justify-between gap-4 px-4 sm:px-6">
          <div className="flex items-center gap-2.5 min-w-0">
            <button
              type="button"
              onClick={() => {
                if (!isOnline) {
                  handlePlayAgain();
                } else if (onlineRoom && isOnlineHost && onlineRoom.screen !== 'LOBBY') {
                  handleOnlineReset();
                }
              }}
              className="font-display text-base sm:text-lg font-extrabold tracking-tight text-[#0F172A] whitespace-nowrap shrink-0 text-left focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-[#4338CA] rounded-md"
            >
              Kim, Kiminle, Nerede?
            </button>

            {isOnline && onlineRoom && (
              <span className="hidden sm:inline-flex items-center gap-1.5 rounded-lg bg-[#EEF2FF] px-2.5 py-1 font-mono text-xs font-bold text-[#4338CA] whitespace-nowrap shrink-0">
                <span
                  aria-hidden="true"
                  className={`h-2 w-2 rounded-full ${
                    mp.connectionStatus === 'connected'
                      ? 'bg-[#16A34A]'
                      : 'bg-amber-500'
                  }`}
                />
                Oda: {onlineRoom.code}
              </span>
            )}
          </div>

          <div className="flex items-center gap-1 sm:gap-2 shrink-0">
            {isOnline && onlineRoom && (
              <button
                type="button"
                onClick={mp.leaveRoom}
                aria-label="Odadan çık"
                className="flex h-11 items-center gap-1.5 rounded-xl px-3 text-xs sm:text-sm font-semibold text-[#64748B] transition-colors hover:bg-slate-100 hover:text-[#0F172A] focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-[#4338CA] whitespace-nowrap shrink-0"
              >
                <LogOut className="h-4 w-4" aria-hidden="true" />
                <span className="hidden sm:inline">Ayrıl</span>
              </button>
            )}

            {!isOnline && screen !== 'LOBBY' && (
              <button
                type="button"
                onClick={handlePlayAgain}
                aria-label="Lobiye dön"
                className="flex h-11 items-center gap-1.5 rounded-xl px-3 text-xs sm:text-sm font-semibold text-[#64748B] transition-colors hover:bg-slate-100 hover:text-[#0F172A] focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-[#4338CA] whitespace-nowrap shrink-0"
              >
                <RotateCcw className="h-4 w-4" aria-hidden="true" />
                <span className="hidden sm:inline">Lobi</span>
              </button>
            )}

            <button
              type="button"
              onClick={() => setRulesOpen(true)}
              aria-label="Nasıl oynanır"
              className="flex h-11 items-center gap-1.5 rounded-xl px-3 text-xs sm:text-sm font-semibold text-[#64748B] transition-colors hover:bg-slate-100 hover:text-[#0F172A] focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-[#4338CA] whitespace-nowrap shrink-0"
            >
              <HelpCircle className="h-4 w-4" aria-hidden="true" />
              <span className="hidden sm:inline">Kurallar</span>
            </button>

            <button
              type="button"
              onClick={() => setSoundEnabled((prev) => !prev)}
              aria-label={soundEnabled ? 'Sesi kapat' : 'Sesi aç'}
              className="flex h-11 w-11 items-center justify-center rounded-xl text-[#64748B] transition-colors hover:bg-slate-100 hover:text-[#0F172A] focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-[#4338CA]"
            >
              {soundEnabled ? (
                <Volume2 className="h-5 w-5" aria-hidden="true" />
              ) : (
                <VolumeX className="h-5 w-5" aria-hidden="true" />
              )}
            </button>
          </div>
        </div>
      </header>

      <main className="mx-auto w-full max-w-5xl flex-1 px-4 py-5 sm:px-6 sm:py-8">
        <div className="grid grid-cols-1 gap-8 lg:grid-cols-12 lg:items-start">
          <section className="lg:col-span-7" aria-label="Oyun alanı">
            {effectiveScreen === 'LOBBY' && (
              <div className="space-y-5">
                <div>
                  <div className="mb-4 flex flex-wrap items-start justify-between gap-3">
                    <div>
                      <h1 className="font-display text-2xl sm:text-3xl font-extrabold tracking-tight text-[#0F172A] text-balance">
                        Kim, Kiminle, Nerede?
                      </h1>
                      <p className="mt-1.5 text-sm sm:text-base text-[#64748B]">
                        {isOnline
                          ? 'Oda kur veya kodla katıl, herkes kendi cihazından gizlice yazsın.'
                          : 'Kişileri ekle, telefonu sırayla dolaştır.'}
                      </p>
                    </div>
                  </div>

                  {(!isOnline || !onlineRoom) && (
                    <div
                      className="mb-4 grid grid-cols-2 gap-1.5 rounded-2xl bg-slate-200/70 p-1.5"
                      role="tablist"
                      aria-label="Oyun modu"
                    >
                      <button
                        type="button"
                        role="tab"
                        aria-selected={isOnline}
                        onClick={() => {
                          soundFx.tap(soundEnabled);
                          setMode('ONLINE');
                        }}
                        className={`flex h-11 items-center justify-center gap-2 rounded-xl px-3 text-sm font-bold transition-colors whitespace-nowrap ${
                          isOnline
                            ? 'bg-white text-[#0F172A] shadow-xs'
                            : 'text-[#64748B] hover:text-[#0F172A]'
                        }`}
                      >
                        <Globe className="h-4 w-4 text-[#4338CA]" aria-hidden="true" />
                        <span>Çevrimiçi Oda</span>
                      </button>

                      <button
                        type="button"
                        role="tab"
                        aria-selected={!isOnline}
                        onClick={() => {
                          soundFx.tap(soundEnabled);
                          setMode('LOCAL');
                        }}
                        className={`flex h-11 items-center justify-center gap-2 rounded-xl px-3 text-sm font-bold transition-colors whitespace-nowrap ${
                          !isOnline
                            ? 'bg-white text-[#0F172A] shadow-xs'
                            : 'text-[#64748B] hover:text-[#0F172A]'
                        }`}
                      >
                        <Smartphone className="h-4 w-4 text-[#4338CA]" aria-hidden="true" />
                        <span>Tek Cihaz</span>
                      </button>
                    </div>
                  )}

                  <FourColumnBar activeStepIndex={0} />
                </div>

                {isOnline ? (
                  <OnlineLobby
                    connectionStatus={mp.connectionStatus}
                    connectionFailed={mp.connectionFailed}
                    room={onlineRoom}
                    myPlayerId={mp.myPlayerId}
                    initialRoomCode={initialQuery.roomCode}
                    error={mp.error}
                    onClearError={mp.clearError}
                    onReconnect={mp.reconnectNow}
                    onCreateRoom={mp.createRoom}
                    onJoinRoom={mp.joinRoom}
                    onLeaveRoom={mp.leaveRoom}
                    onRenamePlayer={mp.renamePlayer}
                    onKickPlayer={mp.kickPlayer}
                    onStartGame={mp.startGame}
                  />
                ) : (
                  <LobbyScreen
                    players={players}
                    onAddPlayer={handleAddPlayer}
                    onRenamePlayer={handleRenamePlayer}
                    onRemovePlayer={handleRemovePlayer}
                    onStartGame={handleStartGame}
                  />
                )}
              </div>
            )}

            {effectiveScreen === 'PLAYING' &&
              (isOnline ? (
                onlineRoom &&
                onlineSelfPlayer && (
                  <PlayScreen
                    mode="ONLINE"
                    step={activeStep}
                    player={onlineSelfPlayer}
                    playerIndex={0}
                    totalPlayers={onlineRoom.players.length}
                    inputText={onlineInputText}
                    isHiddenLocked={onlineHasSubmitted}
                    submittedPlayerIds={onlineRoom.submittedPlayerIds}
                    onlinePlayers={onlineRoom.players}
                    isHost={isOnlineHost}
                    onKickPlayer={mp.kickPlayer}
                    onInputChange={setOnlineInputText}
                    onConfirmTick={handleOnlineConfirm}
                  />
                )
              ) : (
                activeLocalPlayer && (
                  <PlayScreen
                    mode="LOCAL"
                    step={activeStep}
                    player={activeLocalPlayer}
                    playerIndex={currentPlayerIndex}
                    totalPlayers={players.length}
                    inputText={inputText}
                    isHiddenLocked={isHiddenLocked}
                    onInputChange={setInputText}
                    onConfirmTick={handleConfirmTick}
                  />
                )
              ))}

            {effectiveScreen === 'SHUFFLING' && (
              <ShuffleScreen
                finishedStepIndex={activeStep.index}
                finishedStepTitle={activeStep.title}
              />
            )}

            {effectiveScreen === 'RESULTS' && (
              <ResultsScreen
                results={isOnline ? (onlineRoom?.results ?? []) : results}
                isOnline={isOnline}
                isHost={isOnline ? isOnlineHost : true}
                onReshuffle={isOnline ? handleOnlineReshuffle : handleReshuffle}
                onPlayAgain={isOnline ? handleOnlineReset : handlePlayAgain}
                onLeaveRoom={isOnline ? mp.leaveRoom : undefined}
              />
            )}
          </section>

          <div className="hidden lg:block lg:col-span-5">
            <RoundSidebar
              mode={mode}
              screen={effectiveScreen}
              players={isOnline ? (onlineRoom?.players ?? []) : players}
              currentStepIndex={effectiveStepIndex}
              currentPlayerIndex={currentPlayerIndex}
              submittedPlayerIds={onlineRoom?.submittedPlayerIds}
              myPlayerId={mp.myPlayerId}
              hostId={onlineRoom?.hostId}
              onKickPlayer={isOnline ? mp.kickPlayer : undefined}
            />
          </div>
        </div>
      </main>

      {rulesOpen && (
        <div
          className="fixed inset-0 z-50 flex items-center justify-center bg-slate-900/50 p-4 backdrop-blur-xs"
          role="dialog"
          aria-modal="true"
          aria-labelledby="rules-modal-title"
          onClick={() => setRulesOpen(false)}
        >
          <div
            className="w-full max-w-md rounded-3xl border border-slate-200 bg-white p-6"
            onClick={(e) => e.stopPropagation()}
          >
            <div className="flex items-center justify-between gap-4">
              <h2
                id="rules-modal-title"
                className="font-display text-xl font-extrabold text-[#0F172A]"
              >
                Nasıl Oynanır?
              </h2>
              <button
                type="button"
                onClick={() => setRulesOpen(false)}
                aria-label="Kapat"
                className="flex h-11 w-11 items-center justify-center rounded-xl text-[#64748B] hover:bg-slate-100 hover:text-[#0F172A] focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-[#4338CA]"
              >
                <X className="h-5 w-5" aria-hidden="true" />
              </button>
            </div>

            <ol className="mt-4 space-y-3 text-sm leading-relaxed text-[#64748B]">
              <li>
                <span className="font-bold text-[#0F172A]">1. Modu Seç:</span>{' '}
                Arkadaşlarınla uzaktan oynamak için <strong>Çevrimiçi Oda</strong> kurup kodu veya davet linkini paylaşabilir, ya da <strong>Tek Cihaz</strong> ile telefonu elden ele dolaştırabilirsin.
              </li>
              <li>
                <span className="font-bold text-[#0F172A]">2. Gizlice Yaz:</span>{' '}
                Sırayla Kim, Kiminle, Nerede ve Ne Yapıyor sorularını cevapla. Tüm cevaplar diğer oyunculardan gizli tutulur.
              </li>
              <li>
                <span className="font-bold text-[#0F172A]">3. Karıştır ve Oku:</span>{' '}
                Kimseye kendi yazdığı gelmeyecek şekilde tüm parçalar karışır ve ortaya çıkan komik cümleler herkesin ekranında görünür.
              </li>
            </ol>

            <button
              type="button"
              onClick={() => setRulesOpen(false)}
              className="mt-6 flex h-12 w-full items-center justify-center rounded-2xl bg-[#4338CA] text-sm font-bold text-white transition-colors hover:bg-[#3730A3] focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-[#4338CA]"
            >
              Anladım
            </button>
          </div>
        </div>
      )}
    </div>
  );
}
