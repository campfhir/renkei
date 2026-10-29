/**
 * Which Graph scope each Teams tool stands on.
 *
 * withScopeGate filters at REGISTRATION (see sharepoint/scopes.ts for why
 * the `default:` branch is load-bearing): a tool missing from this switch
 * inherits the chat-read scope, so every write tool is named explicitly.
 *
 * Teams scopes split by SURFACE, not by verb: chats (Chat.*, ChatMessage.*)
 * and channels (Team.*, Channel.*, ChannelMessage.*) are separate consents
 * in Graph, and presence is a third. A person who granted chats alone sees
 * no channel tool at all, rather than a 403 waiting inside one.
 *
 * The preview/confirm twins the generic act-preview layer generates for the
 * two sends stand on the send's own scope, the Outlook arrangement.
 */
export function teamsScopeFor(toolName: string): string[] {
  switch (toolName) {
    case 'teams_send_chat_message':
    case 'teams_send_chat_message_preview':
    case 'teams_send_chat_message_confirm':
      // Starting a chat that does not exist yet also needs Chat.Create;
      // the catalog's "Send chat messages" option bundles both, and a grant
      // without it gets Graph's 403 naming the missing scope.
      return ['ChatMessage.Send'];

    case 'teams_list_teams':
      return ['Team.ReadBasic.All'];
    case 'teams_list_channels':
      return ['Channel.ReadBasic.All'];
    case 'teams_list_channel_messages':
    case 'teams_list_replies':
      return ['ChannelMessage.Read.All'];
    case 'teams_send_channel_message':
    case 'teams_send_channel_message_preview':
    case 'teams_send_channel_message_confirm':
      return ['ChannelMessage.Send'];

    case 'teams_get_presence':
      return ['Presence.Read.All'];

    default:
      // teams_list_chats, teams_list_chat_messages, teams_search_messages
      return ['Chat.Read'];
  }
}

/** Whether a Microsoft grant carries anything the Teams namespace can stand on. */
export function grantsTeams(scopes: readonly string[]): boolean {
  return scopes.some((scope) =>
    /^(Chat\.|ChatMessage\.|Team\.|Channel\.|ChannelMessage\.|Presence\.)/.test(scope)
  );
}
