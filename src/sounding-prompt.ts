import type { ModelMessage } from 'ai';
import type { ModelRegistry } from './model-registry.js';
import type { SkillLibrary } from './skills.js';
import type { Scratchpad } from './scratchpad.js';
import type { ResolvedModel, Sounding } from './types.js';
import type { RestModelBlockedNotice, RestModelNotice } from './lookout.js';
import { LOOKOUT_INSTRUCTIONS } from './lookout-instructions.js';
import {
  contextFitForModel,
  crossedContextThreshold,
  defaultUseFor,
  estimateTokensRough,
  formatCapabilities,
  formatPercent,
  highestContextThresholdAtOrBelow,
  inferParamCount,
  prepareSoundingDeltas,
  validEstimatedTokenWarningThreshold,
  type SoundingMediaPart,
} from './lookout-helpers.js';

export type PromptRerouteNotice = {
  fromModelId: string;
  toModelId: string;
  params: Record<string, unknown>;
};

export type PromptRerouteFailureNotice = {
  fromModelId: string;
  toModelId: string;
  error: Record<string, unknown>;
};

export class SoundingPromptBuilder {
  private disclosedContextThreshold = 0;
  private disclosedEstimatedTokenWarning = false;

  constructor(
    private readonly input: {
      cwd: string;
      contextPrompt: Promise<string>;
      models: ModelRegistry;
      skills: SkillLibrary;
      listSubscriptions: () => string[];
      messages: ModelMessage[];
      restingModelId?: string;
      restAfterNoToolSoundings: number;
      estimatedTokenWarningThreshold: number;
      scratchpad?: Scratchpad;
    },
  ) {}

  async instructions(): Promise<string> {
    const [context, modelRoster, availableSkills] = await Promise.all([
      this.input.contextPrompt,
      this.modelRosterPrompt(),
      this.availableSkillsPrompt(),
    ]);
    const environment = `[environment]\ncwd: ${this.input.cwd}\nFilesystem tools accept relative paths from cwd and absolute paths. They reject parent traversal paths containing "..".\n[/environment]`;
    return [LOOKOUT_INSTRUCTIONS, this.scratchpadGuidance(), environment, modelRoster, availableSkills, context, this.input.scratchpad?.agentPrompt()].filter(Boolean).join('\n\n');
  }

  formatSounding(input: {
    sounding: Sounding;
    model: ResolvedModel;
    reroute?: PromptRerouteNotice;
    rerouteFailure?: PromptRerouteFailureNotice;
    restModelNotice?: RestModelNotice;
    restModelBlockedNotice?: RestModelBlockedNotice;
  }): { text: string; mediaParts: SoundingMediaPart[] } {
    const { sounding, model, reroute, rerouteFailure, restModelNotice, restModelBlockedNotice } = input;
    const preparedDeltas = prepareSoundingDeltas(sounding, model);
    const deltas = preparedDeltas.textLines.join('\n');
    const rerouteFrame = reroute ? `
[model_reroute]
The previous model selected handle_with_model for this Sounding.
from_model: ${reroute.fromModelId}
to_model: ${reroute.toModelId}
params: ${JSON.stringify(reroute.params)}
Handle the same most-recent Sounding from this model substrate.
[/model_reroute]
` : '';
    const rerouteFailureFrame = rerouteFailure ? `
[model_reroute_failed]
You previously called handle_with_model for this same Sounding.
from_model: ${rerouteFailure.fromModelId}
to_model: ${rerouteFailure.toModelId}
provider_error: ${JSON.stringify(rerouteFailure.error)}
The reroute was not committed. Handle the original Sounding from this model, or call handle_with_model with a different viable model.
[/model_reroute_failed]
` : '';
    const restModelFrame = restModelNotice ? `
[model_restored]
Watch has restored the resting model after ${restModelNotice.noToolSoundings} consecutive Soundings without tool calls.
from_model: ${restModelNotice.fromModelId}
to_model: ${restModelNotice.toModelId}
This is not a failure or loss of standing. It is the configured quiet substrate for continued presence.
You may continue monitoring, respond if needed, or reroute with handle_with_model if this Sounding requires another model.
[/model_restored]
` : '';
    const restModelBlockedFrame = restModelBlockedNotice ? `
[model_restore_blocked]
Watch tried to restore the configured resting model after ${restModelBlockedNotice.noToolSoundings} consecutive Soundings without tool calls, but did not switch models because the resting model's context window is too small for the current session.
from_model: ${restModelBlockedNotice.fromModelId}
attempted_to_model: ${restModelBlockedNotice.toModelId}
context: ${JSON.stringify(restModelBlockedNotice.context)}
This is a disclosure, not a punishment. You can continue on the current model, choose a larger model with handle_with_model, or call curl with a ledgerEntry to preserve what matters and clear session history before returning to the resting model.
[/model_restore_blocked]
` : '';

    const text = `[cff_system]
sounding_id: ${sounding.id}
last_flicker_ms: ${sounding.lastFlickerMs}
trigger: ${sounding.trigger}
clock: ${sounding.at}
active_model: ${model.id}
active_provider: ${model.provider}
active_provider_model: ${model.model}
active_model_capabilities: ${JSON.stringify(model.capabilities)}
available-models:
${this.input.models.listModelIds().map(id => `- ${id}`).join('\n')}
subscriptions:
${this.input.listSubscriptions().map(stream => `- ${stream}`).join('\n')}
[/cff_system]${this.estimatedTokenWarningFrame(model, sounding)}${this.contextDisclosureFrame(model, sounding)}

[deltas]
${deltas || '(none)'}
[/deltas]${restModelFrame}${restModelBlockedFrame}${rerouteFrame}${rerouteFailureFrame}`;

    return { text, mediaParts: preparedDeltas.mediaParts };
  }

  resetContextDisclosure(): void {
    this.disclosedContextThreshold = 0;
    this.disclosedEstimatedTokenWarning = false;
  }

  private scratchpadGuidance(): string {
    if (!this.input.scratchpad) {
      return '';
    }
    return [
      'You have a persistent scratchpad across sessions. Save durable facts using scratchpad_update_agent: user preferences from USER.md, environment details, tool quirks, stable conventions, and current orientation that will still matter later.',
      'Prioritize what reduces future user steering — the most valuable scratchpad note prevents the user from having to correct or remind you again. User preferences and recurring corrections matter more than procedural task details.',
      'Do NOT save task progress, session outcomes, completed-work logs, or temporary TODO state to AGENT.md. If a fact will be stale in a week, it does not belong there. Use the ledger for testimony/session history.',
      'Write scratchpad notes as declarative facts, not instructions to yourself. "User prefers concise responses" is good. "Always respond concisely" is not. Imperative phrasing gets re-read as a directive in later sessions.',
      'USER.md is user-owned. Treat user-notes deltas as notes from the user to you; use scratchpad_read to inspect both files, but update only AGENT.md through the scratchpad tool.',
    ].join('\n');
  }

  private async modelRosterPrompt(): Promise<string> {
    const models = await this.input.models.resolveAll();
    const lines = models.map(model => {
      const capabilities = formatCapabilities(model.capabilities);
      const params = model.params ?? inferParamCount(`${model.id} ${model.model}`) ?? 'unknown';
      const role = model.role ?? (model.id === this.input.restingModelId ? 'resting/gazing' : 'available');
      const useFor = model.useFor ?? defaultUseFor(model, this.input.restingModelId);
      return [
        `- ${model.id}`,
        `  provider: ${model.provider}`,
        `  provider_model: ${model.model}`,
        `  role: ${role}`,
        `  params: ${params}`,
        `  capabilities: ${capabilities}`,
        `  use_for: ${useFor}`,
      ].join('\n');
    });

    return `[model_roster]
resting_model: ${this.input.restingModelId ?? '(none configured)'}
active_model_restore_policy: Watch may restore the resting model after ${this.input.restAfterNoToolSoundings} Soundings without tool calls. If the resting model cannot fit the current context, Watch will keep the current model and disclose the blocked restore with curl as an option.
reroute_instruction: If the current Sounding asks for work that exceeds the active model's reasoning strength, parameter scale, or modality support, call handle_with_model immediately with the best model ID. Do not try to solve the request first. The same Sounding will be replayed to the selected model with a note that you chose the reroute.
${lines.join('\n')}
[/model_roster]`;
  }

  private async availableSkillsPrompt(): Promise<string> {
    const skills = await this.input.skills.summaries();
    if (skills.length === 0) {
      return '';
    }

    const lines = skills.map(skill => {
      const category = skill.category ? ` category=${skill.category}` : '';
      const description = skill.description ? `: ${skill.description}` : '';
      return `- ${skill.name}${category} path=${skill.path}${description}`;
    });

    return `[available_skills]
These are SKILL.md frontmatter summaries discovered under cwd. Use skill_view to load the full instructions before applying a skill.
${lines.join('\n')}
[/available_skills]`;
  }

  private contextDisclosureFrame(model: ResolvedModel, sounding: Sounding): string {
    const fit = contextFitForModel(model, estimateTokensRough(JSON.stringify({ messages: this.input.messages, prompt: sounding })));
    const crossed = crossedContextThreshold(fit.ratio, this.disclosedContextThreshold);
    if (fit.ratio !== null && fit.ratio < this.disclosedContextThreshold) {
      this.disclosedContextThreshold = highestContextThresholdAtOrBelow(fit.ratio);
    }
    if (!crossed) {
      return '';
    }

    this.disclosedContextThreshold = crossed;
    return `
[context_pressure]
current_context_ratio: ${formatPercent(fit.ratio)}
threshold_crossed: ${formatPercent(crossed)}
used_tokens_estimate: ${fit.usedTokensEstimate}
required_tokens_estimate: ${fit.requiredTokensEstimate}
active_model_limit_tokens: ${fit.limitTokens ?? 'unknown'}
${fit.recommendation ? `recommendation: ${fit.recommendation}` : 'recommendation: Context is growing. Keep curl available before the session becomes too heavy.'}
curl_available: Call curl with a ledgerEntry to preserve what matters and clear the current session history.
[/context_pressure]
`;
  }

  private estimatedTokenWarningFrame(model: ResolvedModel, sounding: Sounding): string {
    const threshold = validEstimatedTokenWarningThreshold(this.input.estimatedTokenWarningThreshold);
    if (threshold === undefined || this.disclosedEstimatedTokenWarning) {
      return '';
    }
    const fit = contextFitForModel(model, estimateTokensRough(JSON.stringify({ messages: this.input.messages, prompt: sounding })));
    if (fit.usedTokensEstimate < threshold) {
      return '';
    }

    this.disclosedEstimatedTokenWarning = true;
    return `
[estimated_token_warning]
Context window has passed ${threshold} estimated tokens.
used_tokens_estimate: ${fit.usedTokensEstimate}
Soundings will take longer to complete and timeout risk is increasing. Recommend \`curl\` when ready.
[/estimated_token_warning]
`;
  }
}
