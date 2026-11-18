export const Notice = class { constructor(_m?: string, _t?: number) {} };
export const requestUrl = async () => ({ status: 200, text: "", json: {} });

export class TFile {
	path: string;
	constructor(path: string) {
		this.path = path;
	}
}

export class TFolder {
	path: string;
	children: unknown[] = [];
	constructor(path: string) {
		this.path = path;
	}
}
