import { API_BASE_URL } from "../constants";
import { Commentary, CommentaryResponse, Match, MatchResponse } from "../types";

export const fetchMatches = async (limit = 50): Promise<MatchResponse> => {
  try {
    const response = await fetch(`${API_BASE_URL}/matches?limit=${limit}`, {
      method: "GET",
    });

    if (!response.ok) {
      throw new Error(`API error: ${response.status} ${response.statusText}`);
    }

    const data = await response.json();
    return data;
  } catch (error) {
    throw error;
  }
};

export const fetchMatchCommentary = async (
  matchId: string | number,
  limit = 100
): Promise<CommentaryResponse> => {
  try {
    const response = await fetch(
      `${API_BASE_URL}/matches/${matchId}/commentary?limit=${limit}`,
      {
        method: "GET",
      }
    );

    if (!response.ok) {
      throw new Error(`API error: ${response.status} ${response.statusText}`);
    }

    const data = await response.json();
    return data;
  } catch (error) {
    throw error;
  }
};

export const updateMatchScore = async (
  matchId: string | number,
  homeScore: number,
  awayScore: number
): Promise<{ data: Match }> => {
  const response = await fetch(`${API_BASE_URL}/matches/${matchId}/score`, {
    method: "PATCH",
    headers: { "Content-Type": "application/json" },
    body: JSON.stringify({ homeScore, awayScore }),
  });

  if (!response.ok) {
    const errorBody = await response.json().catch(() => ({}));
    throw new Error(errorBody.error || `Failed to update score: ${response.status}`);
  }

  return response.json();
};

export const postCommentary = async (
  matchId: string | number,
  commentaryData: {
    message: string;
    minute?: number;
    eventType?: string;
    actor?: string;
    team?: string;
  }
): Promise<{ data: Commentary }> => {
  const response = await fetch(`${API_BASE_URL}/matches/${matchId}/commentary`, {
    method: "POST",
    headers: { "Content-Type": "application/json" },
    body: JSON.stringify(commentaryData),
  });

  if (!response.ok) {
    const errorBody = await response.json().catch(() => ({}));
    throw new Error(errorBody.error || `Failed to post commentary: ${response.status}`);
  }

  return response.json();
};
