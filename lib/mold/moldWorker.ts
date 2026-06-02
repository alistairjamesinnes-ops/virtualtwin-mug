import { generateTwoPartMold, ProfilePoint } from "./generateTwoPartMold";

function toBase64(data: Uint8Array): string {
  let binary = "";

  for (let i = 0; i < data.byteLength; i++) {
    binary += String.fromCharCode(data[i]);
  }

  return btoa(binary);
}

self.onmessage = (event: MessageEvent) => {
  try {
    self.postMessage({
      status: "progress",
      message: "Reading profile...",
    });

    const profile = event.data?.profile as ProfilePoint[] | undefined;
    const heightMm = event.data?.heightMm as number | undefined;

    self.postMessage({
      status: "progress",
      message: "Generating mould halves...",
    });

    const result = generateTwoPartMold({
      profile: profile ?? [],
      heightMm: heightMm ?? 100,
    });

    if (!result.left || !result.right) {
      throw new Error("Mould generator did not return left and right STL data.");
    }

    self.postMessage({
      status: "progress",
      message: "Encoding STL files...",
    });

    const leftBase64 = toBase64(result.left);
    const rightBase64 = toBase64(result.right);

    self.postMessage({
      status: "done",
      leftBase64,
      rightBase64,
    });
  } catch (error: any) {
    self.postMessage({
      status: "error",
      message: error?.message || "Failed to generate mould.",
    });
  }
};

export {};