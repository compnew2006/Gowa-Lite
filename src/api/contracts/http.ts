export interface ResponseData<T> {
  code: string;
  message: string;
  results?: T;
}

export interface ApiError {
  status: number;
  code: string;
  message: string;
}
