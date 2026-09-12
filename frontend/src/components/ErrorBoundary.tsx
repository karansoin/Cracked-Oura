import { Component, type ErrorInfo, type ReactNode } from "react";
import { AlertCircle, RotateCcw } from "lucide-react";
import { Button } from "@/components/ui/button";

interface Props {
    children: ReactNode;
    fallback?: ReactNode;
    /** When any of these change the boundary resets automatically (e.g. the selected day). */
    resetKeys?: ReadonlyArray<unknown>;
}

interface State {
    hasError: boolean;
    error: Error | null;
}

const keysChanged = (a?: ReadonlyArray<unknown>, b?: ReadonlyArray<unknown>) =>
    !!a && !!b && (a.length !== b.length || a.some((v, i) => !Object.is(v, b[i])));

export class ErrorBoundary extends Component<Props, State> {
    public state: State = {
        hasError: false,
        error: null,
    };

    public static getDerivedStateFromError(error: Error): State {
        return { hasError: true, error };
    }

    public componentDidCatch(error: Error, errorInfo: ErrorInfo) {
        console.error("Uncaught error:", error, errorInfo);
    }

    public componentDidUpdate(prevProps: Props) {
        if (this.state.hasError && keysChanged(prevProps.resetKeys, this.props.resetKeys)) {
            this.reset();
        }
    }

    private reset = () => {
        this.setState({ hasError: false, error: null });
    };

    public render() {
        if (this.state.hasError) {
            if (this.props.fallback) {
                return this.props.fallback;
            }

            return (
                <div className="flex h-full flex-col items-center justify-center rounded-md border border-dashed border-destructive/40 p-4 text-center" role="alert">
                    <AlertCircle className="mb-2 h-6 w-6 text-destructive" aria-hidden="true" />
                    <p className="text-sm font-medium text-foreground">This widget hit an error</p>
                    <p className="max-w-[220px] truncate text-xs text-muted-foreground" title={this.state.error?.message}>
                        {this.state.error?.message || "Unknown error"}
                    </p>
                    <Button variant="outline" size="sm" className="mt-3" onClick={this.reset}>
                        <RotateCcw className="h-3.5 w-3.5" aria-hidden="true" />
                        Retry
                    </Button>
                </div>
            );
        }

        return this.props.children;
    }
}
