import { Check, Lock, X } from 'lucide-react';
import { GAME_STEPS } from '../types/game.ts';
import type {
  Player,
  PlayMode,
  RoomPlayer,
  ScreenState,
} from '../types/game.ts';

interface RoundSidebarProps {
  mode: PlayMode;
  screen: ScreenState;
  players: (Player | RoomPlayer)[];
  currentStepIndex: number;
  currentPlayerIndex: number;
  submittedPlayerIds?: string[];
  myPlayerId?: string | null;
  hostId?: string | null;
  onKickPlayer?: (playerId: string) => void;
}

export function RoundSidebar({
  mode,
  screen,
  players,
  currentStepIndex,
  currentPlayerIndex,
  submittedPlayerIds = [],
  myPlayerId = null,
  hostId = null,
  onKickPlayer,
}: RoundSidebarProps) {
  const isOnline = mode === 'ONLINE';
  const isHost = Boolean(myPlayerId && hostId && myPlayerId === hostId);

  return (
    <aside className="rounded-3xl border border-slate-200/80 bg-white p-6">
      <h3 className="font-display text-base font-bold text-[#0F172A]">
        Oyun Akışı
      </h3>
      <p className="mt-1 text-sm text-[#64748B]">
        {isOnline
          ? 'Her aşamada herkes kendi cihazından gizlice yazar. Tüm oyuncular gönderince cevaplar kimseye kendi yazdığı gelmeyecek şekilde karışır.'
          : 'Her aşamada herkes kendi cevabını yazar. Cevaplar gizlenir ve kimseye kendi yazdığı denk gelmeyecek şekilde karıştırılır.'}
      </p>

      <div className="mt-5 border-t border-slate-100 pt-5">
        <p className="text-xs font-semibold text-[#64748B]">Aşamalar</p>
        <ol className="mt-3 space-y-2.5">
          {GAME_STEPS.map((step) => {
            const isDone =
              screen === 'RESULTS' ||
              (screen === 'SHUFFLING' && step.index <= currentStepIndex) ||
              (screen === 'PLAYING' && step.index < currentStepIndex);
            const isActive =
              screen === 'PLAYING' && step.index === currentStepIndex;

            return (
              <li
                key={step.key}
                className="flex items-center justify-between gap-3 text-sm"
              >
                <div className="flex items-center gap-2.5">
                  <span
                    className={`flex h-6 w-6 shrink-0 items-center justify-center rounded-full font-mono text-xs font-bold tabular-nums ${
                      isDone
                        ? 'bg-[#DCFCE7] text-[#166534]'
                        : isActive
                          ? 'bg-[#4338CA] text-white'
                          : 'bg-[#F6F7FB] text-[#64748B]'
                    }`}
                  >
                    {isDone ? (
                      <Check className="h-3.5 w-3.5 stroke-[2.5]" aria-hidden="true" />
                    ) : (
                      step.index + 1
                    )}
                  </span>
                  <span
                    className={
                      isActive || isDone
                        ? 'font-semibold text-[#0F172A]'
                        : 'text-[#64748B]'
                    }
                  >
                    {step.title}
                  </span>
                </div>

                <span className="text-xs text-[#64748B]">
                  {isDone ? 'Tamam' : isActive ? 'Yazılıyor' : 'Sırada'}
                </span>
              </li>
            );
          })}
        </ol>
      </div>

      <div className="mt-5 border-t border-slate-100 pt-5">
        <div className="flex items-center justify-between">
          <p className="text-xs font-semibold text-[#64748B]">Oyuncular</p>
          <span className="font-mono text-xs font-semibold tabular-nums text-[#64748B]">
            {players.length} kişi
          </span>
        </div>

        {players.length === 0 ? (
          <p className="mt-3 text-sm text-[#64748B]">
            Oda kurduğunda veya bir odaya katıldığında oyuncular burada görünür.
          </p>
        ) : (
          <ul className="mt-3 space-y-2">
            {players.map((player, idx) => {
              const roomPlayer = 'connected' in player ? player : null;
              const isSelf = isOnline && player.id === myPlayerId;
              const isTurn = isOnline
                ? screen === 'PLAYING' && !submittedPlayerIds.includes(player.id)
                : screen === 'PLAYING' && idx === currentPlayerIndex;
              const hasSubmitted = isOnline
                ? screen === 'RESULTS' ||
                  screen === 'SHUFFLING' ||
                  (screen === 'PLAYING' &&
                    submittedPlayerIds.includes(player.id))
                : screen === 'RESULTS' ||
                  screen === 'SHUFFLING' ||
                  (screen === 'PLAYING' && idx < currentPlayerIndex);

              return (
                <li
                  key={player.id}
                  className="flex items-center justify-between gap-2 text-sm"
                >
                  <span
                    className={`truncate ${
                      isTurn || isSelf
                        ? 'font-bold text-[#4338CA]'
                        : 'font-medium text-[#0F172A]'
                    }`}
                  >
                    {idx + 1}. {player.name}
                    {isSelf ? ' (Sen)' : ''}
                  </span>

                  <div className="flex items-center gap-1.5 shrink-0">
                    {screen !== 'LOBBY' ? (
                      <span className="flex items-center gap-1 text-xs text-[#64748B] whitespace-nowrap">
                        {hasSubmitted ? (
                          <>
                            <Lock
                              className="h-3 w-3 text-[#16A34A]"
                              aria-hidden="true"
                            />
                            <span className="text-[#166534]">Gizli</span>
                          </>
                        ) : roomPlayer && !roomPlayer.connected ? (
                          <span className="text-slate-400">Çevrimdışı</span>
                        ) : isTurn ? (
                          <span className="font-semibold text-[#4338CA]">
                            {isOnline ? 'Yazıyor...' : 'Sıra onda'}
                          </span>
                        ) : (
                          <span>Bekliyor</span>
                        )}
                      </span>
                    ) : roomPlayer ? (
                      <span className="flex items-center gap-1.5 text-xs text-[#64748B] whitespace-nowrap">
                        <span
                          aria-hidden="true"
                          className={`h-2 w-2 rounded-full ${
                            roomPlayer.connected ? 'bg-[#16A34A]' : 'bg-slate-300'
                          }`}
                        />
                        <span>
                          {roomPlayer.isHost
                            ? 'Yönetici'
                            : roomPlayer.connected
                              ? 'Çevrimiçi'
                              : 'Çevrimdışı'}
                        </span>
                      </span>
                    ) : null}

                    {isOnline &&
                      screen === 'PLAYING' &&
                      isHost &&
                      roomPlayer &&
                      !roomPlayer.connected &&
                      player.id !== myPlayerId &&
                      onKickPlayer && (
                        <button
                          type="button"
                          onClick={() => onKickPlayer(player.id)}
                          aria-label={`${player.name} oyuncusunu çıkar`}
                          className="flex h-6 w-6 items-center justify-center rounded text-[#DC2626] hover:bg-red-50"
                        >
                          <X className="h-3.5 w-3.5" aria-hidden="true" />
                        </button>
                      )}
                  </div>
                </li>
              );
            })}
          </ul>
        )}
      </div>
    </aside>
  );
}
