import { useEffect, useRef } from 'react';
import { Check, EyeOff, Lock, X } from 'lucide-react';
import type { GameStep, Player, PlayMode, RoomPlayer } from '../types/game.ts';
import { FourColumnBar } from './FourColumnBar.tsx';

interface PlayScreenProps {
  mode?: PlayMode;
  step: GameStep;
  player: Player;
  playerIndex: number;
  totalPlayers: number;
  inputText: string;
  isHiddenLocked: boolean;
  submittedPlayerIds?: string[];
  onlinePlayers?: RoomPlayer[];
  isHost?: boolean;
  onKickPlayer?: (playerId: string) => void;
  onInputChange: (val: string) => void;
  onConfirmTick: () => void;
}

export function PlayScreen({
  mode = 'LOCAL',
  step,
  player,
  playerIndex,
  totalPlayers,
  inputText,
  isHiddenLocked,
  submittedPlayerIds = [],
  onlinePlayers = [],
  isHost = false,
  onKickPlayer,
  onInputChange,
  onConfirmTick,
}: PlayScreenProps) {
  const textareaRef = useRef<HTMLTextAreaElement>(null);

  useEffect(() => {
    if (!isHiddenLocked) {
      textareaRef.current?.focus();
    }
  }, [step.index, player.id, isHiddenLocked]);

  const canSubmit = inputText.trim().length > 0 && !isHiddenLocked;
  const isOnline = mode === 'ONLINE';
  const submittedCount = submittedPlayerIds.length;

  return (
    <div className="flex flex-col justify-between gap-6">
      <div>
        <FourColumnBar activeStepIndex={step.index} />

        <div className="mt-5 flex items-baseline justify-between gap-4">
          <p className="font-display text-lg sm:text-xl font-bold text-[#4338CA] truncate">
            {isOnline ? `Sen: ${player.name}` : `Sıra: ${player.name}`}
          </p>
          <span className="font-mono text-sm font-bold tabular-nums text-[#64748B] whitespace-nowrap shrink-0">
            {isOnline
              ? `${submittedCount} / ${totalPlayers} gönderdi`
              : `${playerIndex + 1} / ${totalPlayers}`}
          </span>
        </div>

        <div className="mt-3.5 rounded-3xl border border-slate-200/80 bg-white p-5 sm:p-6">
          <div className="flex items-baseline justify-between gap-3">
            <h2 className="font-display text-2xl sm:text-3xl font-extrabold tracking-tight text-[#0F172A]">
              {step.title}
            </h2>
            <span className="text-xs font-medium text-[#64748B] whitespace-nowrap">
              Gizli giriş
            </span>
          </div>

          <div className="mt-4">
            {isHiddenLocked ? (
              <div
                className="flex h-36 w-full flex-col items-center justify-center rounded-2xl bg-[#0F172A] px-4 text-center"
                role="status"
                aria-live="polite"
              >
                <EyeOff
                  className="h-8 w-8 text-[#16A34A]"
                  aria-hidden="true"
                />
                <p className="mt-2.5 text-base font-bold text-white">
                  {isOnline
                    ? 'Cevabın Gizlendi'
                    : 'Gizlendi ve Karışmaya Girdi'}
                </p>
                {isOnline && (
                  <p className="mt-1 text-xs font-medium text-slate-300">
                    Diğer oyuncular bekleniyor ({submittedCount} / {totalPlayers})
                  </p>
                )}
              </div>
            ) : (
              <div>
                <label htmlFor="step-answer-input" className="sr-only">
                  {step.title} cevabın
                </label>
                <textarea
                  ref={textareaRef}
                  id="step-answer-input"
                  value={inputText}
                  onChange={(e) => onInputChange(e.target.value)}
                  onKeyDown={(e) => {
                    if (e.key === 'Enter' && !e.shiftKey) {
                      e.preventDefault();
                      if (canSubmit) {
                        onConfirmTick();
                      }
                    }
                  }}
                  placeholder={step.hint}
                  maxLength={160}
                  rows={4}
                  className="h-36 w-full resize-none rounded-2xl border border-slate-200 bg-[#F6F7FB]/50 p-4 text-base sm:text-lg text-[#0F172A] placeholder:text-[#64748B] focus:border-[#4338CA] focus:bg-white focus:outline-none focus-visible:ring-2 focus-visible:ring-[#4338CA]/30 transition-colors"
                />
              </div>
            )}
          </div>
        </div>

        {isOnline && onlinePlayers.length > 0 && (
          <div className="mt-4 rounded-2xl border border-slate-200/80 bg-white p-4 lg:hidden">
            <p className="text-xs font-semibold text-[#64748B]">
              Oyuncu Durumları
            </p>
            <ul className="mt-2.5 space-y-2">
              {onlinePlayers.map((p) => {
                const done = submittedPlayerIds.includes(p.id);
                return (
                  <li
                    key={p.id}
                    className="flex items-center justify-between gap-2 text-sm"
                  >
                    <span className="truncate font-medium text-[#0F172A]">
                      {p.name}
                    </span>
                    <div className="flex items-center gap-2 shrink-0">
                      {done ? (
                        <span className="flex items-center gap-1 text-xs font-semibold text-[#166534]">
                          <Lock className="h-3 w-3" aria-hidden="true" />
                          <span>Gönderdi</span>
                        </span>
                      ) : !p.connected ? (
                        <span className="text-xs font-medium text-slate-400">
                          Çevrimdışı
                        </span>
                      ) : (
                        <span className="text-xs font-semibold text-[#4338CA]">
                          Yazıyor...
                        </span>
                      )}

                      {isHost && !p.connected && p.id !== player.id && onKickPlayer && (
                        <button
                          type="button"
                          onClick={() => onKickPlayer(p.id)}
                          aria-label={`${p.name} oyuncusunu çıkar`}
                          className="flex h-7 w-7 items-center justify-center rounded-lg text-[#DC2626] hover:bg-red-50"
                        >
                          <X className="h-3.5 w-3.5" aria-hidden="true" />
                        </button>
                      )}
                    </div>
                  </li>
                );
              })}
            </ul>
          </div>
        )}
      </div>

      {!isHiddenLocked && (
        <button
          type="button"
          onClick={onConfirmTick}
          disabled={!canSubmit}
          className="flex h-15 w-full items-center justify-center gap-2 rounded-2xl bg-[#16A34A] px-6 text-base sm:text-lg font-bold text-white transition-all duration-150 hover:bg-[#15803D] active:scale-[0.99] disabled:cursor-not-allowed disabled:bg-slate-300 disabled:text-slate-500 focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-[#16A34A] focus-visible:ring-offset-2 whitespace-nowrap shrink-0"
        >
          <Check className="h-6 w-6 stroke-[2.5]" aria-hidden="true" />
          <span>
            {isOnline ? 'Okey — Gizle ve Gönder' : 'Okey — Gizle ve Devam Et'}
          </span>
        </button>
      )}
    </div>
  );
}
