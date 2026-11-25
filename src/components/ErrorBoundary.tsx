import { Component, type ErrorInfo, type ReactNode } from 'react';
import { RefreshCw } from 'lucide-react';

interface ErrorBoundaryProps {
  children: ReactNode;
}

interface ErrorBoundaryState {
  hasError: boolean;
}

export class ErrorBoundary extends Component<
  ErrorBoundaryProps,
  ErrorBoundaryState
> {
  state: ErrorBoundaryState = { hasError: false };

  static getDerivedStateFromError(): ErrorBoundaryState {
    return { hasError: true };
  }

  componentDidCatch(error: Error, info: ErrorInfo) {
    console.error('Uygulama hatası:', error, info);
  }

  private handleReload = () => {
    window.location.reload();
  };

  render() {
    if (this.state.hasError) {
      return (
        <div className="flex min-h-screen items-center justify-center bg-[#F6F7FB] p-6 text-[#0F172A]">
          <div className="w-full max-w-md rounded-3xl border border-slate-200 bg-white p-6 text-center">
            <h1 className="font-display text-xl font-extrabold text-[#0F172A]">
              Beklenmeyen bir sorun oluştu
            </h1>
            <p className="mt-2 text-sm leading-relaxed text-[#64748B]">
              Oyuna devam etmek için sayfayı yenileyebilirsin.
            </p>
            <button
              type="button"
              onClick={this.handleReload}
              className="mt-5 flex h-12 w-full items-center justify-center gap-2 rounded-2xl bg-[#4338CA] px-5 text-sm font-bold text-white transition-colors hover:bg-[#3730A3]"
            >
              <RefreshCw className="h-4 w-4" aria-hidden="true" />
              <span>Sayfayı Yenile</span>
            </button>
          </div>
        </div>
      );
    }

    return this.props.children;
  }
}
