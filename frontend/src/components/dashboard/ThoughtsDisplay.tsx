import { useState } from "react";
import { ChevronDown, ChevronRight, Terminal, Database } from "lucide-react";
import { cn } from "@/lib/utils";

/** One step of the advisor's agent trace as returned by the backend. */
interface AgentStep {
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
        <div className="w-full max-w-2xl bg-card border rounded-lg overflow-hidden text-sm mt-3">
            {/* SQL Query Preview (Always visible if exists) */}
            {sqlQueries.map(({ step, query }, i) => (
                <div key={`sql-${step}-${i}`} className="bg-muted/30 p-3 border-b font-mono text-xs">
                    <div className="flex items-center gap-2 text-muted-foreground mb-2">
                        <Database className="h-3 w-3" />
                        <span className="font-semibold">
                            SQL Query Executed{sqlQueries.length > 1 ? ` (${i + 1}/${sqlQueries.length})` : ''}
                        </span>
                    </div>
                    <div className="text-blue-500 dark:text-blue-400 overflow-x-auto whitespace-pre-wrap bg-background p-2 rounded border">
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
                    <div key={i} className="bg-muted/30 p-3 border-b font-mono text-xs">
                        <div className="flex items-center gap-2 text-muted-foreground mb-2">
                            <Terminal className="h-3 w-3 text-yellow-600 dark:text-yellow-500" />
                            <span className="font-semibold">Python Analysis</span>
                        </div>
                        <div className="space-y-2">
                            <div className="text-yellow-600 dark:text-yellow-400 overflow-x-auto whitespace-pre-wrap bg-background p-2 rounded border">
                                {code}
                            </div>
                            {resultStep && (
                                <div className="text-muted-foreground overflow-x-auto whitespace-pre-wrap bg-background/50 p-2 rounded border border-dashed">
                                    <span className="text-[10px] uppercase tracking-wider font-semibold text-muted-foreground/70 block mb-1">Result</span>
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
                    onClick={() => setIsOpen(!isOpen)}
                    className="w-full flex items-center justify-between p-2 px-3 bg-muted/10 hover:bg-muted/30 transition-colors text-xs text-muted-foreground"
                >
                    <span className="flex items-center gap-2">
                        <Terminal className="h-3 w-3" />
                        Internal Monologue & Debug Info
                    </span>
                    {isOpen ? <ChevronDown className="h-3 w-3" /> : <ChevronRight className="h-3 w-3" />}
                </button>

                {isOpen && (
                    <div className="p-3 bg-muted/10 space-y-3 border-t">
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
            <div className="font-semibold text-foreground/80 flex items-center gap-2 mb-1">
                <span className="bg-primary/10 text-primary px-1.5 py-0.5 rounded text-[10px] uppercase tracking-wider">
                    Step {step.step}
                </span>
                {step.type}
            </div>
            <div className="font-mono bg-background p-2 rounded border text-muted-foreground whitespace-pre-wrap overflow-x-auto relative">
                <div className={cn(
                    "overflow-hidden transition-all",
                    !isExpanded && isLong ? "max-h-[150px] mask-linear-fade" : ""
                )}>
                    {content}
                </div>
                {isLong && (
                    <button
                        onClick={() => setIsExpanded(!isExpanded)}
                        className="mt-2 text-[10px] uppercase tracking-wider font-bold text-primary hover:underline flex items-center gap-1"
                    >
                        {isExpanded ? "Show Less" : "Show Full Output"}
                        {isExpanded ? <ChevronDown className="h-3 w-3" /> : <ChevronRight className="h-3 w-3" />}
                    </button>
                )}
            </div>
        </div>
    );
}
