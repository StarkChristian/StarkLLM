import { useState } from 'react';

export function useChatFolders({ getHeaders, handleLogout, activeWorkspace, setChats }) {
  const [chatFolders, setChatFolders] = useState([]);

  const fetchChatFolders = async (workspaceId) => {
    try {
      const res = await fetch(`/api/v1/chat/folders/${workspaceId}`, { headers: getHeaders() });
      if (res.status === 401) { handleLogout(); return; }
      if (!res.ok) return;
      const data = await res.json();
      setChatFolders(data);
    } catch (err) {
      console.error('Error fetching chat folders:', err);
    }
  };

  const handleCreateFolder = async (name) => {
    if (!activeWorkspace) return;
    try {
      const res = await fetch(`/api/v1/chat/folders/${activeWorkspace.id}`, {
        method: 'POST',
        headers: getHeaders({ 'Content-Type': 'application/json' }),
        body: JSON.stringify({ name })
      });
      if (res.status === 401) { handleLogout(); return; }
      if (!res.ok) return;
      const newFolder = await res.json();
      setChatFolders(prev => [newFolder, ...prev]);
    } catch (err) {
      console.error('Error creating chat folder:', err);
    }
  };

  const handleRenameFolder = async (folderId, name) => {
    try {
      const res = await fetch(`/api/v1/chat/folders/${folderId}`, {
        method: 'PUT',
        headers: getHeaders({ 'Content-Type': 'application/json' }),
        body: JSON.stringify({ name })
      });
      if (res.status === 401) { handleLogout(); return; }
      if (!res.ok) return;
      const updatedFolder = await res.json();
      setChatFolders(prev => prev.map(f => f.id === folderId ? updatedFolder : f));
    } catch (err) {
      console.error('Error renaming chat folder:', err);
    }
  };

  const handleDeleteFolder = async (folderId) => {
    try {
      const res = await fetch(`/api/v1/chat/folders/${folderId}`, {
        method: 'DELETE',
        headers: getHeaders()
      });
      if (res.status === 401) { handleLogout(); return; }
      if (!res.ok) return;
      setChatFolders(prev => prev.filter(f => f.id !== folderId));
      if (setChats) {
        setChats(prev => prev.map(c => 
          c.folder_id === folderId ? { ...c, folder_id: null } : c
        ));
      }
    } catch (err) {
      console.error('Error deleting chat folder:', err);
    }
  };

  const handleMoveChat = async (chatId, folderId) => {
    try {
      const res = await fetch(`/api/v1/chat/session/${chatId}/move`, {
        method: 'PUT',
        headers: getHeaders({ 'Content-Type': 'application/json' }),
        body: JSON.stringify({ folder_id: folderId === 'null' || folderId === null ? null : parseInt(folderId, 10) })
      });
      if (res.status === 401) { handleLogout(); return; }
      if (!res.ok) return;
      
      if (setChats) {
        setChats(prev => prev.map(c => 
          c.id === chatId ? { ...c, folder_id: folderId === 'null' || folderId === null ? null : parseInt(folderId, 10) } : c
        ));
      }
    } catch (err) {
      console.error('Error moving chat:', err);
    }
  };

  return {
    chatFolders,
    setChatFolders,
    fetchChatFolders,
    handleCreateFolder,
    handleRenameFolder,
    handleDeleteFolder,
    handleMoveChat
  };
}
