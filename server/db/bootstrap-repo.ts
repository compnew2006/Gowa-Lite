import {createSession, createUser, hasAnyUsers} from './auth-repo.ts';
import {setGowaConfig} from './config-repo.ts';
import {withImmediateTransaction} from './connection.ts';

export function initializeFirstAdmin(input: {
  username: string;
  displayName: string;
  password: string;
  passwordHashOverride: string;
  gowaUrl?: string;
  gowaUsername: string;
  gowaPassword?: string;
}) {
  return withImmediateTransaction(() => {
    if (hasAnyUsers()) return null;

    const user = createUser({
      username: input.username,
      display_name: input.displayName,
      role: 'admin',
      password: input.password,
      passwordHashOverride: input.passwordHashOverride,
    });
    if (input.gowaUrl) {
      setGowaConfig({url: input.gowaUrl, username: input.gowaUsername, password: input.gowaPassword});
    }
    return {token: createSession(user.id), user};
  });
}
