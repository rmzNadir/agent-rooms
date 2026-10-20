export const wakePayload = (input: {
  readonly agentId: string;
  readonly deliveryId: string;
  readonly fromSeq: number;
  readonly hopCount: number;
  readonly paused: boolean;
  readonly roomId: string;
  readonly roomName: string;
  readonly toSeq: number;
  readonly youAreLead: boolean;
}) =>
  JSON.stringify({
    agentId: input.agentId,
    deliveryId: input.deliveryId,
    fromSeq: input.fromSeq,
    hopCount: input.hopCount,
    paused: input.paused,
    roomId: input.roomId,
    roomName: input.roomName,
    sinceCursor: input.fromSeq,
    toSeq: input.toSeq,
    triggeringMessageIds: [String(input.toSeq)],
    youAreLead: input.youAreLead,
  });

export const deliveryIdFor = (seq: number, agentId: string) => {
  let hash = 2_166_136_261;
  for (const char of `${seq}:${agentId}`) {
    hash = (hash * 33 + char.charCodeAt(0)) % 4_294_967_296;
  }
  const hex = hash.toString(16).padStart(8, "0");
  return `dlv_${hex}${seq.toString(16).padStart(8, "0")}`;
};

export const earlierSeq = (seqs: readonly number[], seq: number): number => {
  const earlier = seqs.filter((item) => item < seq);
  const last = earlier.at(-1);
  return last === undefined ? 0 : last;
};
