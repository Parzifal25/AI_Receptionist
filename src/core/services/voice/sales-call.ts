import "server-only";
import { selectLanguagePack } from "@halo/language/language-pack";
import { logger } from "@halo/platform/logger";
import { NegotiationSystemActionProvider } from "@halo/negotiation/system-action";
import type { NegotiationPolicy } from "@halo/negotiation/policy";
import type { ObjectionCatalog } from "@halo/negotiation/objections";
import { concessionExecutor } from "@halo/negotiation/tool";
import { computeDisposition } from "@halo/qualification/disposition";
import { emptySnapshot, type QualificationSnapshot } from "@halo/qualification/engine";
import type { QualificationSchema } from "@halo/qualification/schema";
import { QualificationSystemActionProvider, qualificationSlots } from "@halo/qualification/system-action";
import type { LLMProvider } from "@halo/ports/llm-provider";
import type { ConversationStateStore } from "@halo/runtime/conversation-state";
import type { EscalationReason, RuntimeEventSink, RuntimeOutput } from "@halo/runtime/contracts";
import type { KnowledgeResolver } from "@halo/runtime/knowledge-resolver";
import type { ConversationStore, SystemActionProvider } from "@halo/runtime/system-actions";
import type { OutcomeDraft, VoiceCallContext } from "@halo/voice/gateway";
import { PhoneTurnHandler, resolvedContextForCall } from "@halo/voice/phone-channel-adapter";
import type { VoiceTurnHandler } from "@halo/voice/turn-handler";
import type { VoiceSessionSummary } from "@halo/voice/voice-session";

const log = logger.child({ service: "sales-call" });

/**
 * HALO Phase 4 — assembly of a qualification/sales voice call.
 *
 * The application's job, exactly as `ChatService` is for the web channel:
 * bind trusted services to the UNCHANGED runtime. It knows the SHAPE of a
 * sales call — qualification, objections, commercial policy, disposition —
 * and nothing about any particular business. Every piece of content arrives
 * as `SalesCallConfig`, which a tenant directory supplies
 * (src/content/tenants/*).
 *
 * Order of the system actions matters and is deliberate:
 *   1. qualification — decides what is actually known and what to ask next;
 *   2. negotiation   — sees that snapshot, so a concession conditioned on
 *                      "owns the property" is evaluated against what
 *                      qualification just captured this same turn;
 *   3. static        — the tenant's standing guidance (e.g. the questions
 *                      with no verified answer).
 *
 * All three run BEFORE the model and hand it verified ground truth. The
 * model phrases; it does not decide.
 *
 * Per-call state lives here, keyed by call id, because the gateway asks for
 * the outcome after the session has already been torn down.
 */

export interface SalesCallConfig {
  qualification: QualificationSchema;
  objections: ObjectionCatalog;
  negotiation: NegotiationPolicy;
  /** Standing prompt sections (tenant-authored). Rendered every turn. */
  staticSections: string[];
  /** Escalation reasons that trigger a LIVE transfer rather than a callback. */
  liveTransferReasons: EscalationReason[];
  language: string;
}

export interface SalesCallDeps {
  config: SalesCallConfig;
  llm: LLMProvider;
  knowledge: KnowledgeResolver;
  conversations: ConversationStore;
  stateStore: ConversationStateStore;
  events?: RuntimeEventSink;
  /** Observes every completed runtime turn (telemetry, evaluation). */
  onTurnOutput?: (ctx: VoiceCallContext, output: RuntimeOutput) => void;
}

interface CallState {
  qualification: QualificationSystemActionProvider;
  negotiation: NegotiationSystemActionProvider;
  snapshot: QualificationSnapshot;
  appointmentId: string | null;
  escalationRequested: boolean;
  turns: number;
}

export class SalesCallAssembly {
  private readonly calls = new Map<string, CallState>();

  constructor(private readonly deps: SalesCallDeps) {}

  /** `VoiceGatewayDeps.createTurnHandler`. */
  readonly createTurnHandler = (ctx: VoiceCallContext): VoiceTurnHandler => {
    const { config } = this.deps;
    const selection = selectLanguagePack(config.language);
    if (!selection.supported) {
      // Loud, metered degradation: the deterministic layer is reduced, and
      // somebody has to know. It is never a silent no-op.
      log.error("no language pack for the configured language; deterministic parsing is reduced", {
        callId: ctx.call.id,
        ...selection.downgrade,
      });
    }

    const state: CallState = {
      qualification: undefined as unknown as QualificationSystemActionProvider,
      negotiation: undefined as unknown as NegotiationSystemActionProvider,
      snapshot: emptySnapshot(),
      appointmentId: null,
      escalationRequested: false,
      turns: 0,
    };

    const handler = new PhoneTurnHandler({
      agent: resolvedContextForCall({ business: ctx.route.business, agentId: ctx.route.agentId, version: ctx.route.version }),
      conversationId: ctx.conversationId,
      store: this.deps.conversations,
      llm: this.deps.llm,
      knowledge: this.deps.knowledge,
      stateStore: this.deps.stateStore,
      liveHandoffAvailable: ctx.handoffNumber !== null,
      transferReasons: config.liveTransferReasons,
      ...(this.deps.events ? { events: this.deps.events } : {}),
      systemActions: (signals) => {
        state.qualification = new QualificationSystemActionProvider({
          schema: config.qualification,
          pack: selection.pack,
          ...(config.qualification.billRanges ? { billRanges: config.qualification.billRanges } : {}),
          signals: () => ({ sttConfidence: signals().sttConfidence }),
          onUpdate: (snapshot) => {
            state.snapshot = snapshot;
          },
        });
        state.negotiation = new NegotiationSystemActionProvider({
          policy: config.negotiation,
          catalog: config.objections,
          language: config.language,
          // Evaluated against what qualification captured on THIS turn.
          qualification: () => qualificationSlots(state.snapshot),
        });
        const providers: SystemActionProvider[] = [state.qualification, state.negotiation];
        if (config.staticSections.length > 0) providers.push(staticProvider(config.staticSections));
        return providers;
      },
      onTurnOutput: (output) => {
        state.turns += 1;
        if (output.escalation.escalate) state.escalationRequested = true;
        this.deps.onTurnOutput?.(ctx, output);
      },
      toolExecutors: {
        offer_concession: concessionExecutor({
          policy: config.negotiation,
          language: config.language,
          snapshot: () => ({
            ...state.negotiation.current().snapshot,
            fields: qualificationSlots(state.snapshot),
          }),
          recordOffer: (id) => state.negotiation.recordOffer(id),
        }),
      },
    });

    this.calls.set(ctx.call.id, state);
    return handler;
  };

  /**
   * `VoiceGatewayDeps.computeOutcome`. Derived from what actually happened —
   * never from anything the model asserted.
   */
  readonly computeOutcome = (ctx: VoiceCallContext, summary: VoiceSessionSummary): OutcomeDraft => {
    const state = this.calls.get(ctx.call.id);
    this.calls.delete(ctx.call.id);
    if (!state) {
      return {
        disposition: summary.transferred ? "escalated_to_human" : "no_outcome",
        dispositionReason: "no qualification state for this call",
        qualification: {},
        appointmentId: null,
        escalated: summary.transferRequested,
        doNotCall: false,
      };
    }
    const result = computeDisposition({
      snapshot: state.snapshot,
      appointmentId: state.appointmentId,
      transferred: summary.transferred,
      escalationRequested: state.escalationRequested || summary.transferRequested,
      turns: summary.turns,
    });
    return {
      disposition: result.disposition,
      dispositionReason: result.reason,
      qualification: {
        fields: qualificationSlots(state.snapshot),
        status: state.snapshot.status,
        unresolved: state.snapshot.unresolved,
        negotiationRequests: state.negotiation?.current().snapshot.requests ?? 0,
        concessionsOffered: Object.keys(state.negotiation?.current().snapshot.offered ?? {}),
      },
      appointmentId: result.appointmentId,
      escalated: result.escalated,
      doNotCall: result.doNotCall,
    };
  };
}

/** Standing tenant guidance, rendered unchanged every turn. */
function staticProvider(sections: string[]): SystemActionProvider {
  return {
    name: "tenant_guidance",
    prepare: async () => ({ sections, actions: [] }),
  };
}
