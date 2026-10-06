'use client';
import { AiModeStrategyNotice, useAiMode } from '../ai-settings-panel';
import { StrategyControlCards } from '../bot-controls';
import { PageHeader, Panel, Status } from '../components';

export default function StrategiesPage() {
  const aiMode = useAiMode();
  return <><PageHeader eyebrow="Jelzésgenerálás" title="Stratégiák" subtitle="Mely stratégiák adhatnak vételi jelzést, és milyen küszöbökkel" action={<Status tone="positive">CSAK JELZÉSEK</Status>} /><Panel title="Stratégia beállítások" description="A részletes küszöbök és az összetett jelzés a Beállítások → Stratégiák alatt módosíthatók." className={aiMode ? 'ai-mode-dimmed' : ''}><AiModeStrategyNotice aiMode={aiMode} /><StrategyControlCards /></Panel></>;
}
