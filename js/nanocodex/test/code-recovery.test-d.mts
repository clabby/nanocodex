import { Agent as NodeAgent, Transport as NodeTransport, type CodeEffectJournal } from '../node/index.mjs';
import { Agent as HostAgent, Transport as HostTransport, type CodeEffectContext, type CodeEffectReceipt } from '../host/index.mjs';
import { type CodeEffectJournal as RootJournal } from '../index.mjs';

function ownedJournalContract(journal: CodeEffectJournal, context: CodeEffectContext, receipt: CodeEffectReceipt) {
  const rootJournal: RootJournal = journal;
  rootJournal.begin({ ...context, operationId: "original", modelCallIndex: 1, parentCallId: context.callId, source: "host-tool:effect" });
  rootJournal.complete(context, { ...receipt, value: null, thrown: false });
  rootJournal.complete(context, { ...receipt, valueUndefined: true });
  rootJournal.complete(context, { ...receipt, structuredResultRef: "output", valueRef: "structured_result" });
  rootJournal.complete(context, { ...receipt, outputJsonRef: "structured_result", valueRef: "structured_result" });
  NodeAgent.create({ transport: NodeTransport.openAi({ apiKey: 'synthetic' }), codeEffectJournal: journal });
  HostAgent.create({ transport: HostTransport.openAi({ apiKey: 'synthetic' }), codeEffectJournal: journal });
}
void ownedJournalContract;
