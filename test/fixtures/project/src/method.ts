export class UserRepo {
  find() { return 'user'; }
}

export class AuthService {
  constructor(private repo: UserRepo) {}
  refresh() { return this.repo.find(); }
}
