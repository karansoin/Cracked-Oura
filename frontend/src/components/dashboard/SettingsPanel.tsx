import { useEffect, useState } from 'react';
import { toast } from 'sonner';
import { CheckCircle2, Eye, EyeOff, Keyboard, Loader2, Settings, XCircle } from 'lucide-react';
import { Button } from '@/components/ui/button';
import { Input } from '@/components/ui/input';
import { Label } from '@/components/ui/label';
import { Select, SelectContent, SelectItem, SelectTrigger, SelectValue } from '@/components/ui/select';
import { SidePanel, PanelSectionHeading } from '@/components/layout/SidePanel';
import { useTheme } from '@/components/theme-provider';
import { useAppStatus, toastError } from '@/contexts/AppStatusContext';
import { useDashboard } from '@/contexts/DashboardContext';
import { api, type AdvisorStatus, type LlmProvider, type Units } from '@/lib/api';

interface SettingsPanelProps {
    onClose: () => void;
}

const SECRET_MASK = '********';

export function SettingsPanel({ onClose }: SettingsPanelProps) {
    const { settings, updateSettings, refreshSettings } = useAppStatus();
    const { setShortcutSheetOpen } = useDashboard();
    const { theme, setTheme } = useTheme();

    // AI Analyst form (explicit Save so half-typed hosts are not persisted)
    const [provider, setProvider] = useState<LlmProvider>('ollama');
    const [host, setHost] = useState('');
    const [model, setModel] = useState('');
    const [baseUrl, setBaseUrl] = useState('');
    const [apiKey, setApiKey] = useState('');
    const [showKey, setShowKey] = useState(false);
    const [dirty, setDirty] = useState(false);
    const [saving, setSaving] = useState(false);
    const [testing, setTesting] = useState(false);
    const [status, setStatus] = useState<AdvisorStatus | null>(null);

    useEffect(() => { void refreshSettings(); }, [refreshSettings]);

    // Hydrate the form from stored settings (once per load; not while the user is editing)
    useEffect(() => {
        if (!settings || dirty) return;
        setProvider(settings.llm_provider === 'openai_compatible' ? 'openai_compatible' : 'ollama');
        setHost(settings.llm_host ?? '');
        setModel(settings.llm_model ?? '');
        setBaseUrl(settings.llm_base_url ?? '');
        setApiKey(settings.llm_api_key ?? '');
    }, [settings, dirty]);

    const loadStatus = async () => {
        setTesting(true);
        try {
            const s = await api.getAdvisorStatus();
            setStatus(s);
            return s;
        } catch (err) {
            setStatus({ ok: false, provider, models: [], model, model_available: false, error: err instanceof Error ? err.message : 'Failed' });
            return null;
        } finally {
            setTesting(false);
        }
    };

    useEffect(() => { void loadStatus(); /* eslint-disable-line react-hooks/exhaustive-deps -- initial probe only */ }, []);

    const saveAi = async () => {
        setSaving(true);
        try {
            await updateSettings({
                llm_provider: provider,
                llm_host: host,
                llm_model: model,
                llm_base_url: baseUrl,
                // '********' is sent back untouched so the stored key is kept.
                llm_api_key: apiKey,
            });
            setDirty(false);
            toast.success('AI Analyst settings saved');
            await loadStatus();
        } catch (err) {
            toastError('Could not save settings', err);
        } finally {
            setSaving(false);
        }
    };

    const testConnection = async () => {
        if (dirty) await saveAi();
        else await loadStatus();
    };

    const setUnits = async (units: Units) => {
        try {
            await updateSettings({ units });
            toast.success(units === 'imperial' ? 'Units set to imperial' : 'Units set to metric');
        } catch (err) {
            toastError('Could not save units', err);
        }
    };

    const modelOptions = status?.models ?? [];
    const mark = (v: () => void) => { v(); setDirty(true); };

    return (
        <SidePanel title="Settings" icon={<Settings className="h-4 w-4" />} onClose={onClose}>
            {/* Units */}
            <section className="space-y-3" aria-labelledby="units-heading">
                <PanelSectionHeading id="units-heading">Units</PanelSectionHeading>
                <div className="space-y-2">
                    <Label htmlFor="units-select">Measurement system</Label>
                    <Select value={settings?.units ?? 'metric'} onValueChange={(v) => void setUnits(v === 'imperial' ? 'imperial' : 'metric')}>
                        <SelectTrigger id="units-select"><SelectValue /></SelectTrigger>
                        <SelectContent>
                            <SelectItem value="metric">Metric (°C, km)</SelectItem>
                            <SelectItem value="imperial">Imperial (°F, mi)</SelectItem>
                        </SelectContent>
                    </Select>
                    <p className="text-xs text-muted-foreground">Temperature is shown as a deviation from your baseline (a Δ), not an absolute temperature.</p>
                </div>
            </section>

            {/* AI Analyst */}
            <section className="space-y-3" aria-labelledby="ai-heading">
                <PanelSectionHeading id="ai-heading">AI Analyst</PanelSectionHeading>
                <p className="text-xs text-muted-foreground">The analyst runs SQL against your local database through a language model you control.</p>

                <div className="space-y-2">
                    <Label htmlFor="provider-select">Provider</Label>
                    <Select value={provider} onValueChange={(v) => mark(() => setProvider(v === 'openai_compatible' ? 'openai_compatible' : 'ollama'))}>
                        <SelectTrigger id="provider-select"><SelectValue /></SelectTrigger>
                        <SelectContent>
                            <SelectItem value="ollama">Ollama (local)</SelectItem>
                            <SelectItem value="openai_compatible">OpenAI-compatible API</SelectItem>
                        </SelectContent>
                    </Select>
                </div>

                {provider === 'ollama' ? (
                    <>
                        <div className="space-y-2">
                            <Label htmlFor="llm-host">Host</Label>
                            <Input id="llm-host" value={host} placeholder="http://127.0.0.1:11434" onChange={(e) => mark(() => setHost(e.target.value))} />
                        </div>
                        <div className="space-y-2">
                            <Label htmlFor="llm-model">Model</Label>
                            {modelOptions.length > 0 ? (
                                <Select value={modelOptions.includes(model) ? model : ''} onValueChange={(v) => mark(() => setModel(v))}>
                                    <SelectTrigger id="llm-model"><SelectValue placeholder={model || 'Choose a model'} /></SelectTrigger>
                                    <SelectContent>
                                        {modelOptions.map(m => <SelectItem key={m} value={m}>{m}</SelectItem>)}
                                    </SelectContent>
                                </Select>
                            ) : (
                                <Input id="llm-model" value={model} placeholder="e.g. llama3.1" onChange={(e) => mark(() => setModel(e.target.value))} />
                            )}
                            {modelOptions.length === 0 && <p className="text-xs text-muted-foreground">Test the connection to list the models Ollama has installed.</p>}
                        </div>
                    </>
                ) : (
                    <>
                        <div className="space-y-2">
                            <Label htmlFor="llm-base-url">Base URL</Label>
                            <Input id="llm-base-url" value={baseUrl} placeholder="https://api.example.com/v1" onChange={(e) => mark(() => setBaseUrl(e.target.value))} />
                        </div>
                        <div className="space-y-2">
                            <Label htmlFor="llm-model-text">Model</Label>
                            <Input id="llm-model-text" value={model} placeholder="e.g. gpt-4o-mini" onChange={(e) => mark(() => setModel(e.target.value))} />
                        </div>
                        <div className="space-y-2">
                            <Label htmlFor="llm-api-key">API key</Label>
                            <div className="flex gap-2">
                                <Input
                                    id="llm-api-key"
                                    type={showKey ? 'text' : 'password'}
                                    value={apiKey}
                                    placeholder="sk-…"
                                    autoComplete="off"
                                    onFocus={() => { if (apiKey === SECRET_MASK) setApiKey(''); }}
                                    onBlur={() => { if (apiKey === '' && settings?.llm_api_key === SECRET_MASK && !dirty) setApiKey(SECRET_MASK); }}
                                    onChange={(e) => mark(() => setApiKey(e.target.value))}
                                />
                                <Button type="button" variant="outline" size="icon" onClick={() => setShowKey(s => !s)} aria-label={showKey ? 'Hide API key' : 'Show API key'} aria-pressed={showKey}>
                                    {showKey ? <EyeOff className="h-4 w-4" /> : <Eye className="h-4 w-4" />}
                                </Button>
                            </div>
                            <p className="text-xs text-muted-foreground">
                                {settings?.llm_api_key === SECRET_MASK ? 'A key is stored. Leave it as-is to keep it, or type a new one.' : 'Stored locally in the app config.'}
                            </p>
                        </div>
                    </>
                )}

                <div className="flex gap-2 pt-1">
                    <Button className="flex-1" onClick={() => void saveAi()} disabled={saving || !dirty}>
                        {saving && <Loader2 className="h-4 w-4 animate-spin motion-reduce:animate-none" aria-hidden="true" />}
                        Save
                    </Button>
                    <Button variant="outline" className="flex-1" onClick={() => void testConnection()} disabled={testing || saving}>
                        {testing && <Loader2 className="h-4 w-4 animate-spin motion-reduce:animate-none" aria-hidden="true" />}
                        Test connection
                    </Button>
                </div>

                {status && (
                    <div className="space-y-1 rounded-md border bg-background p-3 text-xs" role="status">
                        <p className="flex items-center gap-1.5 font-medium">
                            {status.ok ? <CheckCircle2 className="h-3.5 w-3.5 text-[#007A59] dark:text-[#3FC9A2]" aria-hidden="true" /> : <XCircle className="h-3.5 w-3.5 text-destructive" aria-hidden="true" />}
                            {status.ok ? `Connected to ${status.provider}` : `Cannot reach ${status.provider || provider}`}
                        </p>
                        {status.ok && (
                            <p className="text-muted-foreground">
                                Model <span className="font-mono text-foreground">{status.model || model || '—'}</span>{' '}
                                {status.model_available ? 'is available.' : 'is not available on this provider.'}
                                {status.models.length > 0 && ` ${status.models.length} ${status.models.length === 1 ? 'model' : 'models'} listed.`}
                            </p>
                        )}
                        {status.error && <p className="text-destructive">{status.error}</p>}
                    </div>
                )}
            </section>

            {/* Appearance */}
            <section className="space-y-3" aria-labelledby="appearance-heading">
                <PanelSectionHeading id="appearance-heading">Appearance</PanelSectionHeading>
                <div className="space-y-2">
                    <Label htmlFor="theme-select">Theme</Label>
                    <Select value={theme} onValueChange={(v) => setTheme(v === 'light' ? 'light' : v === 'dark' ? 'dark' : 'system')}>
                        <SelectTrigger id="theme-select"><SelectValue /></SelectTrigger>
                        <SelectContent>
                            <SelectItem value="system">System</SelectItem>
                            <SelectItem value="light">Light</SelectItem>
                            <SelectItem value="dark">Dark</SelectItem>
                        </SelectContent>
                    </Select>
                </div>
            </section>

            {/* Keyboard */}
            <section className="space-y-3" aria-labelledby="keyboard-heading">
                <PanelSectionHeading id="keyboard-heading">Keyboard</PanelSectionHeading>
                <Button variant="outline" className="w-full" onClick={() => setShortcutSheetOpen(true)}>
                    <Keyboard className="h-4 w-4" aria-hidden="true" /> Show keyboard shortcuts
                    <kbd className="ml-auto" aria-hidden="true">?</kbd>
                </Button>
            </section>
        </SidePanel>
    );
}
