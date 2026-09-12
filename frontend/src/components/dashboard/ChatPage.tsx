import { useRef, useEffect, useState } from "react";
import { Button } from "@/components/ui/button";
import { Input } from "@/components/ui/input";
import { ScrollArea } from "@/components/ui/scroll-area";
import { Send, Loader2, Bot, User, Trash2 } from "lucide-react";
import { cn } from "@/lib/utils";
import type { Message } from "@/hooks/useChat";
import { ThoughtsDisplay } from "@/components/dashboard/ThoughtsDisplay";

interface ChatPageProps {
    messages: Message[];
    isLoading: boolean;
    onSend: (message: string) => void;
    onClear: () => void;
}

/** Starter questions, grouped loosely from simple trends to trickier joins. */
const SUGGESTIONS = [
    "How is my sleep score trending over the last 90 days?",
    "Which month had the highest average activity score in 2024?",
    "What is my average HRV on weekends vs weekdays?",
    "What is my average sleep efficiency on days with high activity (score > 85)?",
    "List days where sleep score was < 70 but readiness was > 80",
    "On days where I worked out, what was my average sleep latency?",
    "Is there a correlation between my total calories and deep sleep?",
    "How does my readiness compare on days with high vs low stress?",
    "Do I sleep longer on weekends?",
    "Show my lowest heart rate during sleep for the last 30 days",
    "What was my best sleep score in 2024 and what day was it?",
    "List all tags I used last month",
    "What is my average readiness score when the previous night's sleep was bad (< 70)?",
    "Show the distribution of my sleep scores (low, medium, high)",
    "What is my cardiovascular age trend?",
    "How often does my ring battery drop below 20%?",
    "Compare my average deep sleep in winter (Dec–Feb) vs summer (Jun–Aug)",
    "What is my average bedtime on weekends?",
];

export function ChatPage({ messages, isLoading, onSend, onClear }: ChatPageProps) {
    const [input, setInput] = useState("");
    const scrollRef = useRef<HTMLDivElement>(null);

    useEffect(() => {
        if (scrollRef.current && messages.length > 0) {
            scrollRef.current.scrollIntoView({ behavior: "smooth" });
        }
    }, [messages]);

    const handleSend = () => {
        if (!input.trim() || isLoading) return;
        onSend(input.trim());
        setInput("");
    };

    return (
        <div className="mx-auto flex h-full max-w-4xl flex-col gap-4">
            <div className="flex items-center justify-between gap-4">
                <p className="text-sm text-muted-foreground">
                    Ask questions in plain language. The analyst queries your local database through the model set in Settings.
                </p>
                <Button variant="ghost" size="sm" onClick={onClear} disabled={messages.length === 0} className="shrink-0 text-muted-foreground hover:text-destructive">
                    <Trash2 className="h-3.5 w-3.5" aria-hidden="true" />
                    Clear history
                </Button>
            </div>

            <div className="flex min-h-0 flex-1 flex-col overflow-hidden rounded-lg border bg-card">
                <ScrollArea className="min-h-0 flex-1">
                    <div className="space-y-5 p-5">
                        {messages.length === 0 && (
                            <div className="flex flex-col items-center px-4 py-12 text-center">
                                <span className="mb-4 inline-flex h-12 w-12 items-center justify-center rounded-full border bg-background text-muted-foreground">
                                    <Bot className="h-6 w-6" aria-hidden="true" />
                                </span>
                                <h2 className="text-base font-medium">Ask about your data</h2>
                                <p className="mt-1 max-w-md text-sm text-muted-foreground">Try one of these to get started, or type your own question below.</p>
                                <ul className="mx-auto mt-6 flex max-w-3xl flex-wrap justify-center gap-2" aria-label="Suggested questions">
                                    {SUGGESTIONS.map((q) => (
                                        <li key={q}>
                                            <button
                                                type="button"
                                                onClick={() => onSend(q)}
                                                disabled={isLoading}
                                                className="max-w-full rounded-full border bg-background px-3 py-1.5 text-left text-xs text-muted-foreground transition-colors hover:border-foreground/30 hover:bg-accent/60 hover:text-foreground focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-ring disabled:opacity-50"
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
                                    "flex gap-3",
                                    msg.role === 'user' ? "flex-row-reverse" : "flex-row"
                                )}
                            >
                                <div className={cn(
                                    "flex h-8 w-8 shrink-0 items-center justify-center rounded-full",
                                    msg.role === 'user' ? "bg-primary text-primary-foreground" : "border bg-background text-muted-foreground"
                                )} aria-hidden="true">
                                    {msg.role === 'user' ? <User className="h-4 w-4" /> : <Bot className="h-4 w-4" />}
                                </div>
                                <div className={cn(
                                    "max-w-[80%] space-y-2",
                                    msg.role === 'user' ? "flex flex-col items-end" : "items-start"
                                )}>
                                    <div className={cn(
                                        "rounded-lg px-4 py-3 text-sm leading-relaxed",
                                        msg.role === 'user'
                                            ? "rounded-tr-sm bg-primary text-primary-foreground"
                                            : "rounded-tl-sm border bg-background"
                                    )}>
                                        <div className="whitespace-pre-wrap">
                                            {msg.content}
                                        </div>
                                    </div>

                                    {msg.role === 'assistant' && msg.thoughts && msg.thoughts.length > 0 && (
                                        <ThoughtsDisplay thoughts={msg.thoughts} />
                                    )}
                                </div>
                            </div>
                        ))}

                        {isLoading && (
                            <div className="flex gap-3" aria-live="polite">
                                <div className="flex h-8 w-8 shrink-0 items-center justify-center rounded-full border bg-background text-muted-foreground" aria-hidden="true">
                                    <Bot className="h-4 w-4" />
                                </div>
                                <div className="flex items-center gap-2.5 rounded-lg rounded-tl-sm border bg-background px-4 py-3">
                                    <Loader2 className="h-4 w-4 animate-spin motion-reduce:animate-none" aria-hidden="true" />
                                    <span className="text-sm text-muted-foreground">Analyzing your data…</span>
                                </div>
                            </div>
                        )}
                        <div ref={scrollRef} />
                    </div>
                </ScrollArea>

                <div className="border-t bg-card p-4">
                    <form
                        onSubmit={(e) => {
                            e.preventDefault();
                            handleSend();
                        }}
                        className="flex gap-2"
                    >
                        <Input
                            value={input}
                            onChange={(e) => setInput(e.target.value)}
                            placeholder="Ask about your health data…"
                            aria-label="Message"
                            disabled={isLoading}
                            className="h-10 flex-1"
                        />
                        <Button type="submit" size="icon" className="h-10 w-10" disabled={isLoading || !input.trim()} aria-label="Send">
                            <Send className="h-4 w-4" />
                        </Button>
                    </form>
                </div>
            </div>
        </div>
    );
}
