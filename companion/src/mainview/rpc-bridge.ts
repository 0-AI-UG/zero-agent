import { Electroview } from "electrobun/view";
import type { CompanionRPC, ActivityEvent } from "../shared/rpc.ts";

type StatusHandler = (state: "disconnected" | "connecting" | "connected", message?: string) => void;
type EventHandler = (event: ActivityEvent) => void;
type SetupProgressHandler = (step: string, detail?: string) => void;

let onStatus: StatusHandler = () => {};
let onEvent: EventHandler = () => {};
let onSetupProgress: SetupProgressHandler = () => {};

export function setHandlers(status: StatusHandler, event: EventHandler) {
	onStatus = status;
	onEvent = event;
}

export function setSetupProgressHandler(handler: SetupProgressHandler) {
	onSetupProgress = handler;
}

const rpc = Electroview.defineRPC<CompanionRPC>({
	handlers: {
		requests: {},
		messages: {
			status: ({ state, message }) => onStatus(state, message),
			event: (event) => onEvent(event),
			setupProgress: ({ step, detail }) => onSetupProgress(step, detail),
		},
	},
});

const electroview = new Electroview({ rpc });

export async function getAutoConnect() {
	return electroview.rpc!.request.getAutoConnect({});
}

export async function connect(token: string, server: string) {
	return electroview.rpc!.request.connect({ token, server });
}

export async function getState() {
	return electroview.rpc!.request.getState({});
}

export async function checkRuntime() {
	return electroview.rpc!.request.checkRuntime({});
}

export async function checkChrome() {
	return electroview.rpc!.request.checkChrome({});
}

export async function setupDocker() {
	return electroview.rpc!.request.setupDocker({});
}

export async function installWsl() {
	return electroview.rpc!.request.installWsl({});
}

export async function getResources() {
	return electroview.rpc!.request.getResources({});
}

export async function removeContainer(id: string) {
	return electroview.rpc!.request.removeContainer({ id });
}

export async function removeImage(id: string) {
	return electroview.rpc!.request.removeImage({ id });
}

export async function pruneAll() {
	return electroview.rpc!.request.pruneAll({});
}
