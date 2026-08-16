import { constants } from "node:fs";
import { lstat, mkdir, open } from "node:fs/promises";
import { dirname } from "node:path";

function isNodeError(error: unknown): error is NodeJS.ErrnoException {
	return error instanceof Error && "code" in error;
}

export async function writePlanMarkdownFile(absolutePath: string, planMarkdown: string): Promise<void> {
	const content = planMarkdown.trim();
	if (!content) throw new Error("present_plan requires non-empty markdown.");

	await mkdir(dirname(absolutePath), { recursive: true });

	try {
		const existing = await lstat(absolutePath);
		if (existing.isSymbolicLink()) {
			throw new Error(`Refusing to write plan file because ${absolutePath} is a symbolic link.`);
		}
		if (!existing.isFile()) {
			throw new Error(`Refusing to write plan file because ${absolutePath} is not a regular file.`);
		}
	} catch (error) {
		if (!isNodeError(error) || error.code !== "ENOENT") throw error;
	}

	const noFollow = typeof constants.O_NOFOLLOW === "number" ? constants.O_NOFOLLOW : 0;
	let handle;
	try {
		handle = await open(absolutePath, constants.O_RDWR | constants.O_CREAT | noFollow, 0o666);
	} catch (error) {
		if (isNodeError(error) && error.code === "ELOOP") {
			throw new Error(`Refusing to write plan file because ${absolutePath} is a symbolic link.`);
		}
		throw error;
	}

	try {
		const opened = await handle.stat();
		if (!opened.isFile()) {
			throw new Error(`Refusing to write plan file because ${absolutePath} is not a regular file.`);
		}
		await handle.truncate(0);
		await handle.writeFile(`${content}\n`, "utf8");
	} finally {
		await handle.close();
	}
}
