import { readdir, readFile } from "fs/promises";
import { join } from "path";
import { homedir } from "os";
import { existsSync } from "fs";

interface MessageMeta {
  id: string;
  sessionID: string;
  role: "user" | "assistant";
  time: { created: number; completed?: number };
  agent?: string;
}

interface TextPart {
  id: string;
  sessionID: string;
  messageID: string;
  type: "text";
  text: string;
}

/**
 * Export a session transcript as markdown
 */
export async function exportTranscript(sessionId: string): Promise<string> {
  const storageDir = join(homedir(), ".local/share/opencode/storage");
  
  try {
    // Get all messages for this session
    const messagesDir = join(storageDir, "message", sessionId);
    if (!existsSync(messagesDir)) {
      return `*No transcript found for session ${sessionId}*`;
    }
    
    const messageFiles = await readdir(messagesDir);
    const messages: MessageMeta[] = [];
    
    for (const file of messageFiles) {
      if (!file.endsWith(".json")) continue;
      const content = await readFile(join(messagesDir, file), "utf-8");
      messages.push(JSON.parse(content));
    }
    
    // Sort by creation time
    messages.sort((a, b) => a.time.created - b.time.created);
    
    // Build transcript
    const lines: string[] = [
      `# Session Transcript`,
      ``,
      `**Session ID:** ${sessionId}`,
      `**Messages:** ${messages.length}`,
      ``,
      `---`,
      ``,
    ];
    
    for (const msg of messages) {
      // Get parts for this message
      const partsDir = join(storageDir, "part", msg.id);
      let textContent = "";
      
      if (existsSync(partsDir)) {
        const partFiles = await readdir(partsDir);
        
        for (const file of partFiles) {
          if (!file.endsWith(".json")) continue;
          const content = await readFile(join(partsDir, file), "utf-8");
          const part = JSON.parse(content);
          
          if (part.type === "text" && part.text) {
            textContent += part.text;
          }
        }
      }
      
      if (textContent) {
        const roleLabel = msg.role === "user" ? "User" : "Assistant";
        const agentLabel = msg.agent ? ` (@${msg.agent})` : "";
        const timestamp = new Date(msg.time.created).toISOString();
        
        lines.push(`### ${roleLabel}${agentLabel}`);
        lines.push(`*${timestamp}*`);
        lines.push(``);
        lines.push(textContent);
        lines.push(``);
        lines.push(`---`);
        lines.push(``);
      }
    }
    
    return lines.join("\n");
    
  } catch (e) {
    console.error(`[ralph:transcript] Failed to export transcript:`, e);
    return `*Error exporting transcript: ${e}*`;
  }
}

/**
 * Get just the final output text from a session (last assistant message)
 */
export async function getSessionFinalOutput(sessionId: string): Promise<string | null> {
  const storageDir = join(homedir(), ".local/share/opencode/storage");
  
  try {
    const messagesDir = join(storageDir, "message", sessionId);
    if (!existsSync(messagesDir)) return null;
    
    const messageFiles = await readdir(messagesDir);
    const messages: MessageMeta[] = [];
    
    for (const file of messageFiles) {
      if (!file.endsWith(".json")) continue;
      const content = await readFile(join(messagesDir, file), "utf-8");
      messages.push(JSON.parse(content));
    }
    
    // Sort by creation time, get last assistant message
    messages.sort((a, b) => b.time.created - a.time.created);
    const lastAssistant = messages.find(m => m.role === "assistant");
    
    if (!lastAssistant) return null;
    
    // Get text parts
    const partsDir = join(storageDir, "part", lastAssistant.id);
    if (!existsSync(partsDir)) return null;
    
    const partFiles = await readdir(partsDir);
    let text = "";
    
    for (const file of partFiles) {
      if (!file.endsWith(".json")) continue;
      const content = await readFile(join(partsDir, file), "utf-8");
      const part = JSON.parse(content);
      if (part.type === "text" && part.text) {
        text += part.text;
      }
    }
    
    return text || null;
    
  } catch (e) {
    console.error(`[ralph:transcript] Failed to get final output:`, e);
    return null;
  }
}
