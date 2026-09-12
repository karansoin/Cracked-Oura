import { useState } from "react";
import { ChevronDown, ChevronRight, Terminal, Database } from "lucide-react";
import { cn } from "@/lib/utils";

/** One step of the advisor's agent trace as returned by the backend. */
export interface AgentStep {
    step: number;
    type: string;
    tool?: string;
    params?: unknown;
    content?: unknown;
}

const isRecord = (value: unknown): value is Record<string, unknown> =>
    value !== null && typeof value === 'object';

/**
 * The backend uses LangChain's SQL agent, whose tools are `sql_db_query`,
 * `sql_db_query_checker`, `sql_db_schema` and `sql_db_list_tables`. Only
 * `sql_db_query` actually executes SQL; its input is either the raw query string
 * or an object with a `query` field.
 */
const SQL_QUERY_TOOL = 'sql_db_query';

const getSqlQuery = (step: AgentStep): string | null => {
    if (typeof step.params === 'string') return step.params;
    if (isRecord(step.params) && typeof step.params.query === 'string') return step.params.query;
    return null;
};

const stringify = (value: unknown): string =>
    typeof value === 'string' ? value : JSON.stringify(value, null, 2) ?? '';

export function ThoughtsDisplay({ thoughts }: { thoughts: AgentStep[] }) {
    const [isOpen, setIsOpen] = useState(false);

    // Every executed SQL query (an agent may run several)
    const sqlQueries = thoughts
        .filter(t => t.tool === SQL_QUERY_TOOL)
        .map(t => ({ step: t.step, query: getSqlQuery(t) }))
        .filter((q): q is { step: number; query: string } => !!q.query);

    return (
        <div className="mt-3 w-full max-w-2xl overflow-hidden rounded-md border bg-card text-sm">
            {/* SQL Query Preview (Always visible if exists) */}
            {sqlQueries.map(({ step, query }, i) => (
                <div key={`sql-${step}-${i}`} className="border-b p-3 font-mono text-xs">
                    <div className="mb-2 flex items-center gap-2 text-muted-foreground">
                        <Database className="h-3 w-3" aria-hidden="true" />
                        <span className="font-sans font-medium">
                            SQL query{sqlQueries.length > 1 ? ` ${i + 1} of ${sqlQueries.length}` : ''}
                        </span>
                    </div>
                    <div className="overflow-x-auto whitespace-pre-wrap rounded border bg-background p-2 text-[#0072B2] dark:text-[#5AA9E6]">
                        {query}
                    </div>
                </div>
            ))}

            {/* Python Code Preview (Always visible if exists) */}
            {thoughts.filter(t => t.tool === 'run_python').map((step, i) => {
                // Find the result (usually the next step)
                const resultStep = thoughts.find(t => t.step === step.step + 1 && t.type === 'tool_result');
                const code = isRecord(step.params) ? stringify(step.params.code ?? '') : stringify(step.params ?? '');
                return (
                    <div key={i} className="border-b p-3 font-mono text-xs">
                        <div className="mb-2 flex items-center gap-2 text-muted-foreground">
                            <Terminal className="h-3 w-3" aria-hidden="true" />
                            <span className="font-sans font-medium">Python analysis</span>
                        </div>
                        <div className="space-y-2">
                            <div className="overflow-x-auto whitespace-pre-wrap rounded border bg-background p-2 text-[#9A6400] dark:text-[#F2B84B]">
                                {code}
                            </div>
                            {resultStep && (
                                <div className="overflow-x-auto whitespace-pre-wrap rounded border border-dashed bg-background/50 p-2 text-muted-foreground">
                                    <span className="mb-1 block font-sans text-xs font-semibold uppercase tracking-wider">Result</span>
                                    {typeof resultStep.content === 'string' ? resultStep.content : JSON.stringify(resultStep.content)}
                                </div>
                            )}
                        </div>
                    </div>
                );
            })}

            {/* Collapsible Internal Monologue */}
            <div>
                <button
                    type="button"
                    onClick={() => setIsOpen(!isOpen)}
                    aria-expanded={isOpen}
                    className="flex h-8 w-full items-center justify-between px-3 text-xs text-muted-foreground transition-colors hover:bg-accent/60 hover:text-foreground focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-ring"
                >
                    <span className="flex items-center gap-2">
                        <Terminal className="h-3 w-3" aria-hidden="true" />
                        Agent steps ({thoughts.length})
                    </span>
                    {isOpen ? <ChevronDown className="h-3 w-3" aria-hidden="true" /> : <ChevronRight className="h-3 w-3" aria-hidden="true" />}
                </button>

                {isOpen && (
                    <div className="space-y-3 border-t p-3">
                        {thoughts.map((step, i) => (
                            <ThoughtStep key={i} step={step} />
                        ))}
                    </div>
                )}
            </div>
        </div>
    );
}

function ThoughtStep({ step }: { step: AgentStep }) {
    const [isExpanded, setIsExpanded] = useState(false);
    const content = stringify(step.content);
    const isLong = content.split('\n').length > 10;

    return (
        <div className="text-xs">
            <div className="mb-1 flex items-center gap-2 font-medium text-foreground">
                <span className="rounded bg-secondary px-1.5 py-0.5 text-xs uppercase tracking-wider text-secondary-foreground">
                    Step {step.step}
                </span>
                <span className="text-muted-foreground">{step.type.replace(/_/g, ' ')}</span>
            </div>
            <div className="relative overflow-x-auto whitespace-pre-wrap rounded border bg-background p-2 font-mono text-muted-foreground">
                <div className={cn(
                    "overflow-hidden transition-all",
                    !isExpanded && isLong ? "max-h-[150px] mask-linear-fade" : ""
                )}>
                    {content}
                </div>
                {isLong && (
                    <button
                        type="button"
                        onClick={() => setIsExpanded(!isExpanded)}
                        className="mt-2 flex h-6 items-center gap-1 rounded font-sans text-xs font-medium text-foreground hover:underline focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-ring"
                    >
                        {isExpanded ? "Show less" : "Show full output"}
                        {isExpanded ? <ChevronDown className="h-3 w-3" aria-hidden="true" /> : <ChevronRight className="h-3 w-3" aria-hidden="true" />}
                    </button>
                )}
            </div>
        </div>
    );
}
