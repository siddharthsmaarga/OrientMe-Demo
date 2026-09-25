// Owns the page's single inference worker and forwards model progress/results.

let worker;
let nextRequestId = 1;
const pending = new Map();

function getWorker() {
  if (worker) return worker;
  if (typeof window === "undefined" || typeof Worker === "undefined") {
    throw new Error("This browser cannot run the local demo model.");
  }

  worker = new Worker(new URL("./model.worker.js", import.meta.url), { type: "module" });
  worker.onmessage = ({ data }) => {
    const request = pending.get(data.id);
    if (!request) return;
    if (data.type === "progress") {
      request.onProgress?.(data.progress);
    } else {
      pending.delete(data.id);
      if (data.type === "result") request.resolve(data.answer);
      else request.reject(new Error(data.message || "The local model could not generate a response."));
    }
  };
  worker.onerror = () => {
    for (const request of pending.values()) request.reject(new Error("The local model stopped unexpectedly. Reload the page and try again."));
    pending.clear();
    worker?.terminate();
    worker = undefined;
  };
  return worker;
}

export function generateDemoAnswer(question, onProgress) {
  return new Promise((resolve, reject) => {
    const id = nextRequestId++;
    try {
      pending.set(id, { resolve, reject, onProgress });
      getWorker().postMessage({ id, question });
    } catch (error) {
      pending.delete(id);
      reject(error);
    }
  });
}
