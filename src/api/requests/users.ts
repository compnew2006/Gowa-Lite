import {http, results} from '@/lib/http';
import type {User, UserCreatePayload, UserUpdatePayload} from '@/api/contracts/auth';
import type {UserCloseRatings, UserRatingSummary} from '@/api/contracts/workflow';

export function listUsers(): Promise<User[]> {
  return results(http.get('/users'));
}

export function listUsersRatings(): Promise<UserRatingSummary[]> {
  return results(http.get('/users/ratings'));
}

export function getUserRatings(userId: number): Promise<UserCloseRatings> {
  return results(http.get(`/users/${userId}/ratings`));
}

export function getMyRatings(): Promise<UserCloseRatings> {
  return results(http.get('/me/ratings'));
}

export function createUser(payload: UserCreatePayload): Promise<User> {
  return results(http.post('/users', payload));
}

export function updateUser(id: number, payload: UserUpdatePayload): Promise<User> {
  return results(http.patch(`/users/${id}`, payload));
}

export async function deleteUser(id: number): Promise<void> {
  await http.delete(`/users/${id}`);
}
