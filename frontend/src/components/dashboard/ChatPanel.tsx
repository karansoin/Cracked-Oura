import { useState, useRef, useEffect } from "react";
import { Button } from "@/components/ui/button";
import { Input } from "@/components/ui/input";
import { ScrollArea } from "@/components/ui/scroll-area";
import { Send, Loader2, Bot, User, Sparkles } from "lucide-react";
import { cn } from "@/lib/utils";
import type { Message } from "@/hooks/useChat";
import { ThoughtsDisplay } from "@/components/dashboard/ThoughtsDisplay";
import { SidePanel } from "@/components/layout/SidePanel";

interface ChatPanelProps {
    onClose: () => void;
    messages: Message[];
    isLoading: boolean;
    onSend: (message: string) => void;
}

const STARTERS = [
    "How is my sleep score trending?",
    "What's my average HRV this month?",
    "Did I meet my activity goals last week?",
    "Show my lowest heart rate during sleep",
];

/** Compact side-chat with the AI Analyst (the full page lives in ChatPage). */
export function ChatPanel({ onClose, messages, isLoading, onSend }: ChatPanelProps) {
    const [input, setInput] = useState("");
    const scrollRef = useRef<HTMLDivElement>(null);

    useEffect(() => {
        if (scrollRef.current) {
            scrollRef.current.scrollIntoView({ behavior: "smooth" });
        }
    }, [messages]);

    const handleSend = async () => {
        if (!input.trim() || isLoading) return;

        onSend(input.trim());
        setInput("");
    };

    return (
        <SidePanel
            title="AI Analyst"
            subtitle="Ask about your health data"
            icon={<Sparkles className="h-4 w-4" />}
            onClose={onClose}
            padded={false}
            footer={(
                <form
                    onSubmit={(e) => {
                        e.preventDefault();
                        void handleSend();
                    }}
                    className="flex gap-2"
                >
                    <Input
                        value={input}
                        onChange={(e) => setInput(e.target.value)}
                        placeholder="Ask a question…"
                        aria-label="Message"
                        disabled={isLoading}
                        className="flex-1"
                    />
                    <Button type="submit" size="icon" disabled={isLoading || !input.trim()} aria-label="Send">
                        <Send className="h-4 w-4" />
                    </Button>
                </form>
            )}
        >
            <ScrollArea className="min-h-0 flex-1">
                <div className="space-y-4 p-4">
                    {messages.length === 0 && (
                        <div className="flex flex-col items-center px-2 py-8 text-center">
                            <span className="mb-3 inline-flex h-10 w-10 items-center justify-center rounded-full border bg-background text-muted-foreground">
                                <Bot className="h-5 w-5" aria-hidden="true" />
                            </span>
                            <p className="text-sm font-medium">Ask about your Oura data</p>
                            <p className="mt-1 text-xs text-muted-foreground">Answers come from the local database via the model set in Settings.</p>
                            <ul className="mt-4 flex w-full flex-col gap-1.5" aria-label="Suggested questions">
                                {STARTERS.map(q => (
                                    <li key={q}>
                                        <button
                                            type="button"
                                            onClick={() => onSend(q)}
                                            disabled={isLoading}
                                            className="w-full rounded-md border bg-background px-3 py-2 text-left text-xs text-muted-foreground transition-colors hover:border-foreground/30 hover:bg-accent/60 hover:text-foreground focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-ring disabled:opacity-50"
                                        >
                                            {q}
                                        </button>
                                    </li>
                                ))}
                            </ul>
                        </div>
                    )}

                    {messages.map((msg, index) => (
                        <div
                            key={index}
                            className={cn(
                                "flex gap-2.5 text-sm",
                                msg.role === 'user' ? "flex-row-reverse" : "flex-row"
                            )}
                        >
                            <div className={cn(
                                "flex h-7 w-7 shrink-0 items-center justify-center rounded-full",
                                msg.role === 'user' ? "bg-primary text-primary-foreground" : "border bg-background text-muted-foreground"
                            )} aria-hidden="true">
                                {msg.role === 'user' ? <User className="h-3.5 w-3.5" /> : <Bot className="h-3.5 w-3.5" />}
                            </div>
                            <div className={cn(
                                "max-w-[85%] rounded-lg px-3 py-2 leading-relaxed",
                                msg.role === 'user'
                                    ? "rounded-tr-sm bg-primary text-primary-foreground"
                                    : "rounded-tl-sm border bg-background"
                            )}>
                                <div className="whitespace-pre-wrap">{msg.content}</div>

                                {msg.role === 'assistant' && msg.thoughts && msg.thoughts.length > 0 && (
                                    <ThoughtsDisplay thoughts={msg.thoughts} />
                                )}
                            </div>
                        </div>
                    ))}

                    {isLoading && (
                        <div className="flex gap-2.5 text-sm" aria-live="polite">
                            <div className="flex h-7 w-7 shrink-0 items-center justify-center rounded-full border bg-background text-muted-foreground" aria-hidden="true">
                                <Bot className="h-3.5 w-3.5" />
                            </div>
                            <div className="flex items-center gap-2 rounded-lg rounded-tl-sm border bg-background px-3 py-2">
                                <Loader2 className="h-3.5 w-3.5 animate-spin motion-reduce:animate-none" aria-hidden="true" />
                                <span className="text-xs text-muted-foreground">Thinking…</span>
                            </div>
                        </div>
                    )}
                    <div ref={scrollRef} />
                </div>
            </ScrollArea>
        </SidePanel>
    );
}
