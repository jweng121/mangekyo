export const workspaceChatEvent = "mangekyo:open-chat";
export function openWorkspaceChat(messageId?:string) {
  window.dispatchEvent(new CustomEvent(workspaceChatEvent,{detail:{messageId}}));
}
