import { FormEvent, useEffect, useState } from 'react';
import {
  Check,
  Copy,
  Link2,
  LogOut,
  Play,
  PlusCircle,
  Users,
  X,
} from 'lucide-react';
import type { RoomSnapshot } from '../types/game.ts';
import type { ConnectionStatus } from '../hooks/useMultiplayerRoom.ts';

interface OnlineLobbyProps {
  connectionStatus: ConnectionStatus;
  room: RoomSnapshot | null;
  myPlayerId: string | null;
  initialRoomCode?: string;
  error: string | null;
  onClearError: () => void;
  onCreateRoom: (playerName: string) => void;
  onJoinRoom: (roomCode: string, playerName: string) => void;
  onLeaveRoom: () => void;
  onRenamePlayer: (name: string) => void;
  onKickPlayer: (targetPlayerId: string) => void;
  onStartGame: () => void;
}

export function OnlineLobby({
  connectionStatus,
  room,
  myPlayerId,
  initialRoomCode = '',
  error,
  onClearError,
  onCreateRoom,
  onJoinRoom,
  onLeaveRoom,
  onRenamePlayer,
  onKickPlayer,
  onStartGame,
}: OnlineLobbyProps) {
  const [playerName, setPlayerName] = useState('');
  const [joinCode, setJoinCode] = useState(initialRoomCode.toUpperCase());
  const [copiedType, setCopiedType] = useState<'code' | 'link' | null>(null);
  const [editingName, setEditingName] = useState('');

  useEffect(() => {
    if (initialRoomCode && !joinCode) {
      setJoinCode(initialRoomCode.toUpperCase());
    }
  }, [initialRoomCode, joinCode]);

  const myPlayer = room?.players.find((p) => p.id === myPlayerId) ?? null;

  useEffect(() => {
    if (myPlayer) {
      setEditingName(myPlayer.name);
    }
  }, [myPlayer?.name]);

  const handleCopy = async (value: string, type: 'code' | 'link') => {
    try {
      await navigator.clipboard.writeText(value);
      setCopiedType(type);
      window.setTimeout(() => {
        setCopiedType((prev) => (prev === type ? null : prev));
      }, 1600);
    } catch {
      // Clipboard blocked in restricted context
    }
  };

  if (!room) {
    const cleanName = playerName.trim();
    const cleanCode = joinCode.trim().toUpperCase();

    const handleCreate = (e: FormEvent) => {
      e.preventDefault();
      if (!cleanName) return;
      onCreateRoom(cleanName);
    };

    const handleJoin = (e: FormEvent) => {
      e.preventDefault();
      if (!cleanName || cleanCode.length < 4) return;
      onJoinRoom(cleanCode, cleanName);
    };

    return (
      <div className="space-y-4">
        {error && (
          <div
            role="alert"
            className="flex items-center justify-between gap-3 rounded-2xl border border-red-200 bg-red-50 px-4 py-3 text-sm font-medium text-red-700"
          >
            <span>{error}</span>
            <button
              type="button"
              onClick={onClearError}
              aria-label="Hata mesajını kapat"
              className="flex h-8 w-8 shrink-0 items-center justify-center rounded-lg text-red-600 hover:bg-red-100"
            >
              <X className="h-4 w-4" aria-hidden="true" />
            </button>
          </div>
        )}

        <div className="rounded-3xl border border-slate-200/80 bg-white p-5 sm:p-6">
          <label
            htmlFor="online-player-name"
            className="block text-xs font-bold uppercase tracking-wider text-[#64748B]"
          >
            Oyuncu Adın
          </label>
          <input
            id="online-player-name"
            type="text"
            value={playerName}
            onChange={(e) => {
              setPlayerName(e.target.value);
              if (error) onClearError();
            }}
            placeholder="Adını yaz..."
            maxLength={32}
            className="mt-2 h-13 w-full rounded-2xl border border-slate-200 bg-[#F6F7FB]/50 px-4 text-base text-[#0F172A] placeholder:text-[#64748B] focus:border-[#4338CA] focus:bg-white focus:outline-none focus-visible:ring-2 focus-visible:ring-[#4338CA]/30 transition-colors"
          />

          <form onSubmit={handleCreate} className="mt-4">
            <button
              type="submit"
              disabled={!cleanName || connectionStatus === 'disconnected'}
              className="flex h-13 w-full items-center justify-center gap-2 rounded-2xl bg-[#4338CA] px-5 text-base font-bold text-white transition-all duration-150 hover:bg-[#3730A3] active:scale-[0.99] disabled:cursor-not-allowed disabled:opacity-45 focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-[#4338CA] focus-visible:ring-offset-2 whitespace-nowrap shrink-0"
            >
              <PlusCircle className="h-5 w-5" aria-hidden="true" />
              <span>Yeni Oda Kur</span>
            </button>
          </form>

          <div className="my-5 flex items-center gap-3">
            <div className="h-px flex-1 bg-slate-200" />
            <span className="text-xs font-semibold text-[#64748B]">
              veya kodla katıl
            </span>
            <div className="h-px flex-1 bg-slate-200" />
          </div>

          <form onSubmit={handleJoin} className="flex items-center gap-2.5">
            <label htmlFor="join-room-code" className="sr-only">
              Oda kodu
            </label>
            <input
              id="join-room-code"
              type="text"
              value={joinCode}
              onChange={(e) => {
                setJoinCode(e.target.value.toUpperCase().replace(/[^A-Z0-9]/g, ''));
                if (error) onClearError();
              }}
              placeholder="ODA KODU"
              maxLength={8}
              className="h-13 min-w-0 flex-1 rounded-2xl border border-slate-200 bg-[#F6F7FB]/50 px-4 font-mono text-base font-bold uppercase tracking-widest text-[#0F172A] placeholder:font-sans placeholder:font-normal placeholder:tracking-normal placeholder:text-[#64748B] focus:border-[#4338CA] focus:bg-white focus:outline-none focus-visible:ring-2 focus-visible:ring-[#4338CA]/30 transition-colors"
            />
            <button
              type="submit"
              disabled={
                !cleanName ||
                cleanCode.length < 4 ||
                connectionStatus === 'disconnected'
              }
              className="flex h-13 shrink-0 items-center justify-center rounded-2xl bg-[#0F172A] px-6 text-base font-bold text-white transition-all duration-150 hover:bg-slate-800 active:scale-[0.98] disabled:cursor-not-allowed disabled:opacity-40 focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-[#0F172A] focus-visible:ring-offset-2 whitespace-nowrap"
            >
              Katıl
            </button>
          </form>
        </div>
      </div>
    );
  }

  const isHost = myPlayerId === room.hostId;
  const inviteUrl =
    typeof window !== 'undefined'
      ? `${window.location.origin}/?room=${room.code}`
      : `/?room=${room.code}`;

  const handleRenameSubmit = (e: FormEvent) => {
    e.preventDefault();
    const trimmed = editingName.trim();
    if (trimmed && trimmed !== myPlayer?.name) {
      onRenamePlayer(trimmed);
    }
  };

  return (
    <div className="flex flex-col justify-between gap-5">
      {error && (
        <div
          role="alert"
          className="flex items-center justify-between gap-3 rounded-2xl border border-red-200 bg-red-50 px-4 py-3 text-sm font-medium text-red-700"
        >
          <span>{error}</span>
          <button
            type="button"
            onClick={onClearError}
            aria-label="Hata mesajını kapat"
            className="flex h-8 w-8 shrink-0 items-center justify-center rounded-lg text-red-600 hover:bg-red-100"
          >
            <X className="h-4 w-4" aria-hidden="true" />
          </button>
        </div>
      )}

      <div className="rounded-3xl border border-[#C7D2FE] bg-[#EEF2FF]/70 p-5 sm:p-6">
        <div className="flex flex-wrap items-center justify-between gap-4">
          <div>
            <p className="text-xs font-bold uppercase tracking-wider text-[#4338CA]">
              Oda Kodu
            </p>
            <p
              data-testid="room-code-display"
              className="mt-1 font-mono text-3xl font-extrabold tracking-[0.2em] text-[#0F172A]"
            >
              {room.code}
            </p>
          </div>

          <div className="flex flex-wrap items-center gap-2">
            <button
              type="button"
              onClick={() => handleCopy(room.code, 'code')}
              className="flex h-11 items-center gap-1.5 rounded-xl border border-slate-200 bg-white px-3.5 text-xs sm:text-sm font-semibold text-[#0F172A] transition-colors hover:bg-slate-50 focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-[#4338CA] whitespace-nowrap shrink-0"
            >
              {copiedType === 'code' ? (
                <>
                  <Check className="h-4 w-4 text-[#16A34A]" aria-hidden="true" />
                  <span className="text-[#166534]">Kopyalandı</span>
                </>
              ) : (
                <>
                  <Copy className="h-4 w-4 text-[#4338CA]" aria-hidden="true" />
                  <span>Kodu Kopyala</span>
                </>
              )}
            </button>

            <button
              type="button"
              onClick={() => handleCopy(inviteUrl, 'link')}
              className="flex h-11 items-center gap-1.5 rounded-xl bg-[#4338CA] px-3.5 text-xs sm:text-sm font-semibold text-white transition-colors hover:bg-[#3730A3] focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-[#4338CA] whitespace-nowrap shrink-0"
            >
              {copiedType === 'link' ? (
                <>
                  <Check className="h-4 w-4" aria-hidden="true" />
                  <span>Link Kopyalandı</span>
                </>
              ) : (
                <>
                  <Link2 className="h-4 w-4" aria-hidden="true" />
                  <span>Davet Linki</span>
                </>
              )}
            </button>
          </div>
        </div>
      </div>

      <div className="rounded-3xl border border-slate-200/80 bg-white">
        <div className="flex items-center justify-between border-b border-slate-100 px-5 py-3.5">
          <div className="flex items-center gap-2">
            <Users className="h-4 w-4 text-[#4338CA]" aria-hidden="true" />
            <h2 className="font-display text-sm font-bold text-[#0F172A]">
              Odadaki Oyuncular
            </h2>
          </div>
          <span className="font-mono text-xs font-bold tabular-nums text-[#64748B]">
            {room.players.length} kişi
          </span>
        </div>

        <ul className="divide-y divide-slate-100">
          {room.players.map((player, index) => {
            const isSelf = player.id === myPlayerId;
            return (
              <li
                key={player.id}
                className="flex items-center justify-between gap-3 px-4 py-3"
              >
                <div className="flex min-w-0 flex-1 items-center gap-3">
                  <span className="flex h-8 w-8 shrink-0 items-center justify-center rounded-full bg-[#EEF2FF] font-mono text-xs font-bold tabular-nums text-[#4338CA]">
                    {index + 1}
                  </span>

                  {isSelf ? (
                    <form
                      onSubmit={handleRenameSubmit}
                      className="flex min-w-0 flex-1 items-center gap-2"
                    >
                      <label htmlFor="self-player-rename" className="sr-only">
                        Adını düzenle
                      </label>
                      <input
                        id="self-player-rename"
                        type="text"
                        value={editingName}
                        maxLength={32}
                        onChange={(e) => setEditingName(e.target.value)}
                        onBlur={() => {
                          const trimmed = editingName.trim();
                          if (trimmed && trimmed !== player.name) {
                            onRenamePlayer(trimmed);
                          } else {
                            setEditingName(player.name);
                          }
                        }}
                        className="-mx-2 min-w-0 flex-1 rounded-lg border border-transparent px-2 py-1 text-base font-semibold text-[#0F172A] hover:border-slate-200 focus:border-[#4338CA] focus:bg-[#F6F7FB]/50 focus:outline-none"
                      />
                    </form>
                  ) : (
                    <span className="min-w-0 flex-1 truncate text-base font-semibold text-[#0F172A]">
                      {player.name}
                    </span>
                  )}
                </div>

                <div className="flex items-center gap-2 shrink-0">
                  <span className="text-xs font-medium text-[#64748B]">
                    {[
                      isSelf ? 'Sen' : null,
                      player.isHost ? 'Yönetici' : null,
                      !player.connected ? 'Çevrimdışı' : null,
                    ]
                      .filter(Boolean)
                      .join(' · ') || 'Hazır'}
                  </span>

                  <span
                    aria-hidden="true"
                    className={`h-2.5 w-2.5 rounded-full ${
                      player.connected ? 'bg-[#16A34A]' : 'bg-slate-300'
                    }`}
                  />

                  {isHost && !isSelf && (
                    <button
                      type="button"
                      onClick={() => onKickPlayer(player.id)}
                      aria-label={`${player.name} oyuncusunu odadan çıkar`}
                      className="flex h-10 w-10 items-center justify-center rounded-xl text-[#DC2626] transition-colors hover:bg-red-50 focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-red-500"
                    >
                      <X className="h-4 w-4" aria-hidden="true" />
                    </button>
                  )}
                </div>
              </li>
            );
          })}
        </ul>
      </div>

      <div className="space-y-3">
        {isHost ? (
          <>
            {room.players.length < 2 && (
              <p className="text-center text-sm font-medium text-[#64748B]">
                Başlamak için en az 1 arkadaşının daha odaya katılmasını bekle.
              </p>
            )}
            <button
              type="button"
              onClick={onStartGame}
              disabled={room.players.length < 2}
              className="flex h-14 w-full items-center justify-center gap-2 rounded-2xl bg-[#4338CA] px-6 text-base font-bold text-white transition-all duration-150 hover:bg-[#3730A3] active:scale-[0.99] disabled:cursor-not-allowed disabled:opacity-45 focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-[#4338CA] focus-visible:ring-offset-2 whitespace-nowrap shrink-0"
            >
              <Play className="h-5 w-5 fill-current" aria-hidden="true" />
              <span>Oyunu Başlat ({room.players.length} Kişi)</span>
            </button>
          </>
        ) : (
          <div
            role="status"
            className="flex h-14 w-full items-center justify-center rounded-2xl border border-slate-200 bg-white px-5 text-sm sm:text-base font-semibold text-[#64748B]"
          >
            Oda yöneticisinin oyunu başlatması bekleniyor...
          </div>
        )}

        <button
          type="button"
          onClick={onLeaveRoom}
          className="flex h-12 w-full items-center justify-center gap-2 rounded-2xl border border-slate-200 bg-white px-5 text-sm font-semibold text-[#64748B] transition-colors hover:bg-slate-50 hover:text-[#0F172A] focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-[#4338CA] whitespace-nowrap shrink-0"
        >
          <LogOut className="h-4 w-4" aria-hidden="true" />
          <span>Odadan Ayrıl</span>
        </button>
      </div>
    </div>
  );
}
