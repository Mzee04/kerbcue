export interface JobDetails {
  pickup: string
  drop: string
  pay: string
  note?: string
}

export interface OpenJob extends JobDetails {
  id: string
  status: 'open'
}

export interface ClaimedJob extends JobDetails {
  id: string
  status: 'claimed'
  courierName: string
  claimedAt: string
}

export interface OpenJobsResponse {
  jobs: OpenJob[]
  courierName: string
}

export interface ClaimResponse {
  job: ClaimedJob
  telegramSynced: boolean | null
}
