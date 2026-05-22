import axios, { AxiosInstance, InternalAxiosRequestConfig } from 'axios';
import {
  LinkedInProfile,
  LinkedInPost,
  LinkedInConnection,
  LinkedInProfileSchema,
  LinkedInPostSchema,
  LinkedInConnectionSchema,
  // Partner-level API access required — commented out until LinkedIn partner approval:
  // LinkedInSkill,
  // LinkedInPosition,
  // LinkedInEducation,
  // LinkedInCertification,
  // LinkedInPublication,
  // LinkedInLanguage,
} from './types.js';
import { Logger } from './logger.js';

/**
 * Interface for anything that can provide a valid access token.
 * This allows the client to always use a fresh token from OAuthManager
 * (with disk persistence and automatic refresh) instead of a static string.
 */
export interface TokenProvider {
  getAccessToken(): Promise<string>;
}

/**
 * Simple wrapper that turns a static token string into a TokenProvider.
 * Used when the caller provides LINKEDIN_ACCESS_TOKEN directly via env.
 */
export class StaticTokenProvider implements TokenProvider {
  constructor(private readonly token: string) {}
  async getAccessToken(): Promise<string> {
    return this.token;
  }
}

export class LinkedInClient {
  private client: AxiosInstance;
  private logger: Logger;
  private tokenProvider: TokenProvider;

  constructor(tokenProvider: TokenProvider | string, logger: Logger = new Logger()) {
    this.logger = logger;
    this.tokenProvider = typeof tokenProvider === 'string'
      ? new StaticTokenProvider(tokenProvider)
      : tokenProvider;

    this.client = axios.create({
      baseURL: 'https://api.linkedin.com/v2',
      headers: {
        'Content-Type': 'application/json',
        'X-Restli-Protocol-Version': '2.0.0',
      },
    });

    // Interceptor injects a fresh Bearer token on every request
    this.client.interceptors.request.use(async (config: InternalAxiosRequestConfig) => {
      const token = await this.tokenProvider.getAccessToken();
      config.headers.Authorization = `Bearer ${token}`;
      return config;
    });
  }

  /** Extract a plain string from a LinkedIn localized-text object or return the value as-is if already a string. */
  private extractString(val: unknown): string {
    if (typeof val === 'string') return val;
    if (val && typeof val === 'object') {
      const obj = val as Record<string, unknown>;
      // { localized: { en_US: "..." } }
      if (obj['localized'] && typeof obj['localized'] === 'object') {
        const loc = obj['localized'] as Record<string, unknown>;
        const found = Object.values(loc).find(v => typeof v === 'string');
        if (found) return found as string;
      }
      // profile picture: { displayImage~: { elements: [{ identifiers: [{ identifier: url }] }] } }
      const displayImage = obj['displayImage~'] as Record<string, unknown> | undefined;
      if (displayImage) {
        const elements = displayImage['elements'] as Array<Record<string, unknown>> | undefined;
        if (elements && elements.length > 0) {
          const last = elements[elements.length - 1];
          const ids = last['identifiers'] as Array<Record<string, unknown>> | undefined;
          if (ids && ids.length > 0) return (ids[0]['identifier'] as string) || '';
        }
      }
    }
    return '';
  }

  private async getRestApiMemberId(): Promise<string> {
    const response = await this.client.get('/me', { params: { projection: '(id)' } });
    const id: string = response.data?.id;
    if (!id) throw new Error('Could not retrieve member ID from /me endpoint');
    return id;
  }

  async getProfile(): Promise<LinkedInProfile> {
    try {
      this.logger.debug('Fetching LinkedIn profile');
      // Try OpenID Connect userinfo endpoint first (works with openid+profile scopes)
      try {
        const token = await this.tokenProvider.getAccessToken();
        const userinfoResponse = await axios.get('https://api.linkedin.com/v2/userinfo', {
          headers: { Authorization: `Bearer ${token}` },
        });
        const d = userinfoResponse.data;
        const profile = LinkedInProfileSchema.parse({
          id: d.sub || '',
          firstName: d.given_name || '',
          lastName: d.family_name || '',
          headline: typeof d.headline === 'string' ? d.headline : this.extractString(d.headline),
          profilePictureUrl: typeof d.picture === 'string' ? d.picture : this.extractString(d.picture),
          vanityName: d.vanityName || '',
        });
        this.logger.info('Successfully fetched LinkedIn profile via userinfo');
        return profile;
      } catch (userinfoError) {
        this.logger.debug('userinfo endpoint failed, trying /me endpoint');
        // Fall back to legacy /me endpoint (requires r_liteprofile scope)
        const response = await this.client.get('/me');
        const d = response.data;
        const profile = LinkedInProfileSchema.parse({
          id: d.id || '',
          firstName: d.localizedFirstName || this.extractString(d.firstName) || '',
          lastName: d.localizedLastName || this.extractString(d.lastName) || '',
          headline: d.localizedHeadline || this.extractString(d.headline) || '',
          profilePictureUrl: this.extractString(d.profilePicture) || '',
          vanityName: d.vanityName || '',
        });
        this.logger.info('Successfully fetched LinkedIn profile via /me');
        return profile;
      }
    } catch (error) {
      this.logger.error('Error fetching LinkedIn profile', error);
      throw new Error(`Failed to fetch LinkedIn profile: ${error instanceof Error ? error.message : 'Unknown error'}`);
    }
  }

  async getPosts(limit: number = 10): Promise<LinkedInPost[]> {
    try {
      this.logger.debug(`Fetching LinkedIn posts (limit: ${limit})`);
      const memberId = await this.getRestApiMemberId();
      const response = await this.client.get('/ugcPosts', {
        params: {
          q: 'authors',
          authors: `List(urn:li:person:${memberId})`,
          count: limit,
        },
      });

      const posts = response.data.elements?.map((post: any) => {
        return LinkedInPostSchema.parse({
          id: post.id,
          author: post.author,
          text: post.specificContent?.['com.linkedin.ugc.ShareContent']?.shareCommentary?.text || '',
          createdAt: new Date(post.created?.time || Date.now()).toISOString(),
          likeCount: post.likesSummary?.totalLikes || 0,
          commentCount: post.commentsSummary?.totalComments || 0,
          shareCount: post.sharesSummary?.totalShares || 0,
        });
      }) || [];

      this.logger.info(`Successfully fetched ${posts.length} LinkedIn posts`);
      return posts;
    } catch (error: any) {
      // r_member_social (read) is a partner-only scope — standard apps get 403.
      if (error?.response?.status === 403) {
        this.logger.warn('LinkedIn posts API returned 403 — r_member_social scope not available. Returning empty list.');
        return [];
      }
      this.logger.error('Error fetching LinkedIn posts', error);
      throw new Error(`Failed to fetch LinkedIn posts: ${error instanceof Error ? error.message : 'Unknown error'}`);
    }
  }

  async getConnections(_limit: number = 50): Promise<LinkedInConnection[]> {
    try {
      this.logger.debug('Fetching LinkedIn first-degree connection count');
      // Official LinkedIn Connections Size API:
      // GET /v2/connections/urn:li:person:{Person ID}
      // Requires r_1st_connections_size scope.
      // Docs: https://learn.microsoft.com/en-us/linkedin/shared/integrations/people/connections-size
      const memberId = await this.getRestApiMemberId();
      // LinkedIn requires the full URN to be percent-encoded in the path variable.
      const urnEncoded = encodeURIComponent(`urn:li:person:${memberId}`);
      const resp = await this.client.get(`/connections/${urnEncoded}`);
      this.logger.info(`LinkedIn connections size raw response: ${JSON.stringify(resp.data)}`);
      const firstDegreeSize: number = resp.data?.firstDegreeSize ?? 0;
      this.logger.info(`LinkedIn first-degree connection count: ${firstDegreeSize}`);
      return [
        LinkedInConnectionSchema.parse({
          id: `connection-count-${memberId}`,
          firstName: 'You have',
          lastName: `${firstDegreeSize} connections`,
          headline: `${firstDegreeSize} first-degree LinkedIn connections`,
        }),
      ];
    } catch (error: any) {
      const status = error?.response?.status;
      const body = JSON.stringify(error?.response?.data ?? {});
      this.logger.warn(`LinkedIn connections size API returned ${status ?? 'unknown error'}: ${body}`);
      if (status === 403) {
        throw new Error(
          `LinkedIn access denied (403) for connection count. ` +
          `The r_1st_connections_size OAuth scope is required. ` +
          `Please reconnect your LinkedIn account from Settings to grant this permission.`
        );
      }
      if (status === 404) {
        throw new Error(
          `LinkedIn connection count endpoint returned 404. ` +
          `Ensure your LinkedIn app has r_1st_connections_size scope approved.`
        );
      }
      this.logger.error('Error fetching LinkedIn connection count', error);
      throw new Error(`Failed to fetch LinkedIn connection count: ${error instanceof Error ? error.message : 'Unknown error'}`);
    }
  }

  // Custom method: dedicated connection size fetch via GET /v2/connections/urn:li:person:{id}
  // Requires r_1st_connections_size OAuth scope. Returns memberId + raw firstDegreeSize.
  async getConnectionSize(): Promise<{ memberId: string; firstDegreeSize: number }> {
    const memberId = await this.getRestApiMemberId();
    try {
      this.logger.debug(`Fetching connection size for member ${memberId}`);
      const urnEncoded = encodeURIComponent(`urn:li:person:${memberId}`);
      const resp = await this.client.get(`/connections/${urnEncoded}`);
      this.logger.info(`LinkedIn connection size raw response: ${JSON.stringify(resp.data)}`);
      const firstDegreeSize: number = resp.data?.firstDegreeSize ?? 0;
      this.logger.info(`LinkedIn first-degree connection size: ${firstDegreeSize}`);
      return { memberId, firstDegreeSize };
    } catch (error: unknown) {
      const err = error as { response?: { status?: number; data?: unknown } };
      const status = err?.response?.status;
      const body = JSON.stringify(err?.response?.data ?? {});
      this.logger.warn(`LinkedIn connection size API returned ${status ?? 'unknown error'}: ${body}`);
      if (status === 403) {
        throw new Error(
          `LinkedIn access denied (403). The r_1st_connections_size OAuth scope is required. ` +
          `Please reconnect your LinkedIn account from Settings to grant this permission.`
        );
      }
      if (status === 404) {
        throw new Error(
          `LinkedIn connection size endpoint returned 404. ` +
          `Ensure your LinkedIn app has the r_1st_connections_size scope approved.`
        );
      }
      throw new Error(`Failed to fetch LinkedIn connection size: ${error instanceof Error ? error.message : 'Unknown error'}`);
    }
  }

  async sharePost(text: string): Promise<{ id: string; url: string }> {
    try {
      this.logger.debug('Creating LinkedIn post');
      const memberId = await this.getRestApiMemberId();
      const response = await this.client.post('/ugcPosts', {
        author: `urn:li:person:${memberId}`,
        lifecycleState: 'PUBLISHED',
        specificContent: {
          'com.linkedin.ugc.ShareContent': {
            shareCommentary: {
              text,
            },
            shareMediaCategory: 'NONE',
          },
        },
        visibility: {
          'com.linkedin.ugc.MemberNetworkVisibility': 'PUBLIC',
        },
      });

      const postId = response.data.id;
      const postUrl = `https://www.linkedin.com/feed/update/${postId}`;

      this.logger.info(`Successfully created LinkedIn post: ${postId}`);
      return { id: postId, url: postUrl };
    } catch (error) {
      this.logger.error('Error creating LinkedIn post', error);
      throw new Error(`Failed to create LinkedIn post: ${error instanceof Error ? error.message : 'Unknown error'}`);
    }
  }

  async deletePost(postUrn: string): Promise<{ deletedId: string }> {
    try {
      this.logger.debug(`Deleting LinkedIn post: ${postUrn}`);
      const encodedUrn = encodeURIComponent(postUrn);
      await this.client.delete(`/ugcPosts/${encodedUrn}`);
      this.logger.info(`Successfully deleted post: ${postUrn}`);
      return { deletedId: postUrn };
    } catch (error: any) {
      const status = error?.response?.status;
      if (status === 403) {
        throw new Error(`LinkedIn access denied (403). Deleting posts requires the w_member_social scope.`);
      }
      if (status === 404) {
        throw new Error(`Post not found (404). The post URN "${postUrn}" may be invalid or already deleted.`);
      }
      this.logger.error('Error deleting LinkedIn post', error);
      throw new Error(`Failed to delete LinkedIn post: ${error instanceof Error ? error.message : 'Unknown error'}`);
    }
  }

  async updatePost(postUrn: string, text: string): Promise<{ oldId: string; newId: string; newUrl: string }> {
    try {
      this.logger.debug(`Updating post: deleting ${postUrn} then republishing`);
      const encodedUrn = encodeURIComponent(postUrn);
      await this.client.delete(`/ugcPosts/${encodedUrn}`);
      this.logger.info(`Deleted old post: ${postUrn}`);
      const result = await this.sharePost(text);
      this.logger.info(`Published updated post: ${result.id}`);
      return { oldId: postUrn, newId: result.id, newUrl: result.url };
    } catch (error: any) {
      const status = error?.response?.status;
      if (status === 403) {
        throw new Error(`LinkedIn access denied (403). Deleting posts requires the w_member_social scope.`);
      }
      if (status === 404) {
        throw new Error(`Post not found (404). The post URN "${postUrn}" may be invalid or already deleted.`);
      }
      this.logger.error('Error updating LinkedIn post', error);
      throw new Error(`Failed to update LinkedIn post: ${error instanceof Error ? error.message : 'Unknown error'}`);
    }
  }

  async searchPeople(keywords: string, limit: number = 10): Promise<LinkedInConnection[]> {
    try {
      this.logger.debug(`Searching LinkedIn people with keywords: ${keywords}`);
      const response = await this.client.get('/search', {
        params: {
          q: 'people',
          keywords,
          count: limit,
        },
      });

      const people = response.data.elements?.map((person: any) => {
        return LinkedInConnectionSchema.parse({
          id: person.id || '',
          firstName: person.firstName?.localized?.en_US || '',
          lastName: person.lastName?.localized?.en_US || '',
          headline: person.headline,
        });
      }) || [];

      this.logger.info(`Successfully found ${people.length} people matching: ${keywords}`);
      return people;
    } catch (error: any) {
      // People search requires partner-level r_network scope; /v2/search?q=people does not exist for standard apps.
      if (error?.response?.status === 403 || error?.response?.status === 404) {
        this.logger.warn('LinkedIn people search is not available with current app permissions (requires partner r_network scope). Returning empty list.');
        return [];
      }
      this.logger.error('Error searching LinkedIn people', error);
      throw new Error(`Failed to search LinkedIn people: ${error instanceof Error ? error.message : 'Unknown error'}`);
    }
  }

  // ─── Profile Management Methods (partner-level API access required) ──────────
  // All methods below require LinkedIn partner approval to use profile write APIs.
  // They are commented out until partner access is granted.

  // async addSkill(skill: LinkedInSkill): Promise<{ id: string }> {
  //   try {
  //     this.logger.debug(`Adding skill: ${skill.name}`);
  //     const profile = await this.getProfile();
  //     const response = await this.client.post(`/people/(id:${profile.id})/skills`, {
  //       name: {
  //         locale: { language: 'en', country: 'US' },
  //         value: skill.name,
  //       },
  //     });
  //     const skillId = response.headers['x-linkedin-id'] || response.data.id;
  //     this.logger.info(`Successfully added skill: ${skill.name} (${skillId})`);
  //     return { id: skillId };
  //   } catch (error: any) {
  //     if (error?.response?.status === 403) {
  //       this.logger.warn('LinkedIn addSkill returned 403 — profile write access requires LinkedIn partner permissions.');
  //       throw new Error('Adding skills requires LinkedIn partner-level API access (w_member_social scope), which is not available with a standard OAuth app.');
  //     }
  //     this.logger.error('Error adding skill', error);
  //     throw new Error(`Failed to add skill: ${error instanceof Error ? error.message : 'Unknown error'}`);
  //   }
  // }

  // async deleteSkill(skillId: string): Promise<void> {
  //   try {
  //     this.logger.debug(`Deleting skill: ${skillId}`);
  //     const profile = await this.getProfile();
  //     await this.client.delete(`/people/(id:${profile.id})/skills/${skillId}`);
  //     this.logger.info(`Successfully deleted skill: ${skillId}`);
  //   } catch (error: any) {
  //     if (error?.response?.status === 403) {
  //       this.logger.warn('LinkedIn deleteSkill returned 403 — profile write access requires LinkedIn partner permissions.');
  //       throw new Error('Deleting skills requires LinkedIn partner-level API access, which is not available with a standard OAuth app.');
  //     }
  //     this.logger.error('Error deleting skill', error);
  //     throw new Error(`Failed to delete skill: ${error instanceof Error ? error.message : 'Unknown error'}`);
  //   }
  // }

  // async addPosition(position: LinkedInPosition): Promise<{ id: string }> {
  //   try {
  //     this.logger.debug(`Adding position: ${position.title} at ${position.company}`);
  //     const profile = await this.getProfile();
  //     const payload: any = {
  //       title: { locale: { language: 'en', country: 'US' }, value: position.title },
  //       company: { locale: { language: 'en', country: 'US' }, value: position.company },
  //       timePeriod: {
  //         startDate: {
  //           year: position.startDate.year,
  //           ...(position.startDate.month && { month: position.startDate.month }),
  //         },
  //       },
  //     };
  //     if (position.description) {
  //       payload.description = { locale: { language: 'en', country: 'US' }, value: position.description };
  //     }
  //     if (position.endDate && !position.current) {
  //       payload.timePeriod.endDate = {
  //         year: position.endDate.year,
  //         ...(position.endDate.month && { month: position.endDate.month }),
  //       };
  //     }
  //     const response = await this.client.post(`/people/(id:${profile.id})/positions`, payload);
  //     const positionId = response.headers['x-linkedin-id'] || response.data.id;
  //     this.logger.info(`Successfully added position: ${position.title} (${positionId})`);
  //     return { id: positionId };
  //   } catch (error: any) {
  //     if (error?.response?.status === 403) {
  //       throw new Error('Adding positions requires LinkedIn partner-level API access (profile write scope), which is not available with a standard OAuth app.');
  //     }
  //     this.logger.error('Error adding position', error);
  //     throw new Error(`Failed to add position: ${error instanceof Error ? error.message : 'Unknown error'}`);
  //   }
  // }

  // async updatePosition(positionId: string, position: Partial<LinkedInPosition>): Promise<void> {
  //   try {
  //     this.logger.debug(`Updating position: ${positionId}`);
  //     const profile = await this.getProfile();
  //     const payload: any = {};
  //     if (position.title) payload.title = { locale: { language: 'en', country: 'US' }, value: position.title };
  //     if (position.company) payload.company = { locale: { language: 'en', country: 'US' }, value: position.company };
  //     if (position.description) payload.description = { locale: { language: 'en', country: 'US' }, value: position.description };
  //     if (position.startDate || position.endDate) {
  //       payload.timePeriod = {};
  //       if (position.startDate) {
  //         payload.timePeriod.startDate = {
  //           year: position.startDate.year,
  //           ...(position.startDate.month && { month: position.startDate.month }),
  //         };
  //       }
  //       if (position.endDate && !position.current) {
  //         payload.timePeriod.endDate = {
  //           year: position.endDate.year,
  //           ...(position.endDate.month && { month: position.endDate.month }),
  //         };
  //       }
  //     }
  //     await this.client.put(`/people/(id:${profile.id})/positions/${positionId}`, payload);
  //     this.logger.info(`Successfully updated position: ${positionId}`);
  //   } catch (error: any) {
  //     if (error?.response?.status === 403) {
  //       throw new Error('Updating positions requires LinkedIn partner-level API access (profile write scope), which is not available with a standard OAuth app.');
  //     }
  //     this.logger.error('Error updating position', error);
  //     throw new Error(`Failed to update position: ${error instanceof Error ? error.message : 'Unknown error'}`);
  //   }
  // }

  // async deletePosition(positionId: string): Promise<void> {
  //   try {
  //     this.logger.debug(`Deleting position: ${positionId}`);
  //     const profile = await this.getProfile();
  //     await this.client.delete(`/people/(id:${profile.id})/positions/${positionId}`);
  //     this.logger.info(`Successfully deleted position: ${positionId}`);
  //   } catch (error: any) {
  //     if (error?.response?.status === 403) {
  //       throw new Error('Deleting positions requires LinkedIn partner-level API access (profile write scope), which is not available with a standard OAuth app.');
  //     }
  //     this.logger.error('Error deleting position', error);
  //     throw new Error(`Failed to delete position: ${error instanceof Error ? error.message : 'Unknown error'}`);
  //   }
  // }

  // async addEducation(education: LinkedInEducation): Promise<{ id: string }> {
  //   try {
  //     this.logger.debug(`Adding education: ${education.schoolName}`);
  //     const profile = await this.getProfile();
  //     const payload: any = { schoolName: { locale: { language: 'en', country: 'US' }, value: education.schoolName } };
  //     if (education.degree) payload.degreeName = { locale: { language: 'en', country: 'US' }, value: education.degree };
  //     if (education.fieldOfStudy) payload.fieldOfStudy = { locale: { language: 'en', country: 'US' }, value: education.fieldOfStudy };
  //     if (education.startDate || education.endDate) {
  //       payload.timePeriod = {};
  //       if (education.startDate) payload.timePeriod.startDate = { year: education.startDate.year, ...(education.startDate.month && { month: education.startDate.month }) };
  //       if (education.endDate) payload.timePeriod.endDate = { year: education.endDate.year, ...(education.endDate.month && { month: education.endDate.month }) };
  //     }
  //     if (education.grade) payload.grade = { locale: { language: 'en', country: 'US' }, value: education.grade };
  //     if (education.activities) payload.activities = { locale: { language: 'en', country: 'US' }, value: education.activities };
  //     const response = await this.client.post(`/people/(id:${profile.id})/educations`, payload);
  //     const educationId = response.headers['x-linkedin-id'] || response.data.id;
  //     this.logger.info(`Successfully added education: ${education.schoolName} (${educationId})`);
  //     return { id: educationId };
  //   } catch (error: any) {
  //     if (error?.response?.status === 403) {
  //       throw new Error('Adding education requires LinkedIn partner-level API access (profile write scope), which is not available with a standard OAuth app.');
  //     }
  //     this.logger.error('Error adding education', error);
  //     throw new Error(`Failed to add education: ${error instanceof Error ? error.message : 'Unknown error'}`);
  //   }
  // }

  // async deleteEducation(educationId: string): Promise<void> {
  //   try {
  //     this.logger.debug(`Deleting education: ${educationId}`);
  //     const profile = await this.getProfile();
  //     await this.client.delete(`/people/(id:${profile.id})/educations/${educationId}`);
  //     this.logger.info(`Successfully deleted education: ${educationId}`);
  //   } catch (error: any) {
  //     if (error?.response?.status === 403) {
  //       throw new Error('Deleting education requires LinkedIn partner-level API access (profile write scope), which is not available with a standard OAuth app.');
  //     }
  //     this.logger.error('Error deleting education', error);
  //     throw new Error(`Failed to delete education: ${error instanceof Error ? error.message : 'Unknown error'}`);
  //   }
  // }

  // async addCertification(certification: LinkedInCertification): Promise<{ id: string }> {
  //   try {
  //     this.logger.debug(`Adding certification: ${certification.name}`);
  //     const profile = await this.getProfile();
  //     const payload: any = {
  //       name: { locale: { language: 'en', country: 'US' }, value: certification.name },
  //       authority: { locale: { language: 'en', country: 'US' }, value: certification.authority },
  //     };
  //     if (certification.licenseNumber) payload.licenseNumber = { locale: { language: 'en', country: 'US' }, value: certification.licenseNumber };
  //     if (certification.startDate || certification.endDate) {
  //       payload.timePeriod = {};
  //       if (certification.startDate) payload.timePeriod.startDate = { year: certification.startDate.year, ...(certification.startDate.month && { month: certification.startDate.month }) };
  //       if (certification.endDate) payload.timePeriod.endDate = { year: certification.endDate.year, ...(certification.endDate.month && { month: certification.endDate.month }) };
  //     }
  //     if (certification.url) payload.url = certification.url;
  //     const response = await this.client.post(`/people/(id:${profile.id})/certifications`, payload);
  //     const certId = response.headers['x-linkedin-id'] || response.data.id;
  //     this.logger.info(`Successfully added certification: ${certification.name} (${certId})`);
  //     return { id: certId };
  //   } catch (error: any) {
  //     if (error?.response?.status === 403) {
  //       throw new Error('Adding certifications requires LinkedIn partner-level API access (profile write scope), which is not available with a standard OAuth app.');
  //     }
  //     this.logger.error('Error adding certification', error);
  //     throw new Error(`Failed to add certification: ${error instanceof Error ? error.message : 'Unknown error'}`);
  //   }
  // }

  // async deleteCertification(certificationId: string): Promise<void> {
  //   try {
  //     this.logger.debug(`Deleting certification: ${certificationId}`);
  //     const profile = await this.getProfile();
  //     await this.client.delete(`/people/(id:${profile.id})/certifications/${certificationId}`);
  //     this.logger.info(`Successfully deleted certification: ${certificationId}`);
  //   } catch (error: any) {
  //     if (error?.response?.status === 403) {
  //       throw new Error('Deleting certifications requires LinkedIn partner-level API access (profile write scope), which is not available with a standard OAuth app.');
  //     }
  //     this.logger.error('Error deleting certification', error);
  //     throw new Error(`Failed to delete certification: ${error instanceof Error ? error.message : 'Unknown error'}`);
  //   }
  // }

  // async addPublication(publication: LinkedInPublication): Promise<{ id: string }> {
  //   try {
  //     this.logger.debug(`Adding publication: ${publication.name}`);
  //     const profile = await this.getProfile();
  //     const payload: any = { name: { locale: { language: 'en', country: 'US' }, value: publication.name } };
  //     if (publication.publisher) payload.publisher = { locale: { language: 'en', country: 'US' }, value: publication.publisher };
  //     if (publication.description) payload.description = { locale: { language: 'en', country: 'US' }, value: publication.description };
  //     if (publication.date) {
  //       payload.date = {
  //         year: publication.date.year,
  //         ...(publication.date.month && { month: publication.date.month }),
  //         ...(publication.date.day && { day: publication.date.day }),
  //       };
  //     }
  //     if (publication.url) payload.url = publication.url;
  //     const response = await this.client.post(`/people/(id:${profile.id})/publications`, payload);
  //     const pubId = response.headers['x-linkedin-id'] || response.data.id;
  //     this.logger.info(`Successfully added publication: ${publication.name} (${pubId})`);
  //     return { id: pubId };
  //   } catch (error: any) {
  //     if (error?.response?.status === 403) {
  //       throw new Error('Adding publications requires LinkedIn partner-level API access (profile write scope), which is not available with a standard OAuth app.');
  //     }
  //     this.logger.error('Error adding publication', error);
  //     throw new Error(`Failed to add publication: ${error instanceof Error ? error.message : 'Unknown error'}`);
  //   }
  // }

  // async deletePublication(publicationId: string): Promise<void> {
  //   try {
  //     this.logger.debug(`Deleting publication: ${publicationId}`);
  //     const profile = await this.getProfile();
  //     await this.client.delete(`/people/(id:${profile.id})/publications/${publicationId}`);
  //     this.logger.info(`Successfully deleted publication: ${publicationId}`);
  //   } catch (error: any) {
  //     if (error?.response?.status === 403) {
  //       throw new Error('Deleting publications requires LinkedIn partner-level API access (profile write scope), which is not available with a standard OAuth app.');
  //     }
  //     this.logger.error('Error deleting publication', error);
  //     throw new Error(`Failed to delete publication: ${error instanceof Error ? error.message : 'Unknown error'}`);
  //   }
  // }

  // async addLanguage(language: LinkedInLanguage): Promise<{ id: string }> {
  //   try {
  //     this.logger.debug(`Adding language: ${language.name}`);
  //     const profile = await this.getProfile();
  //     const payload: any = { name: { locale: { language: 'en', country: 'US' }, value: language.name } };
  //     if (language.proficiency) payload.proficiency = language.proficiency;
  //     const response = await this.client.post(`/people/(id:${profile.id})/languages`, payload);
  //     const langId = response.headers['x-linkedin-id'] || response.data.id;
  //     this.logger.info(`Successfully added language: ${language.name} (${langId})`);
  //     return { id: langId };
  //   } catch (error: any) {
  //     if (error?.response?.status === 403) {
  //       throw new Error('Adding languages requires LinkedIn partner-level API access (profile write scope), which is not available with a standard OAuth app.');
  //     }
  //     this.logger.error('Error adding language', error);
  //     throw new Error(`Failed to add language: ${error instanceof Error ? error.message : 'Unknown error'}`);
  //   }
  // }

  // async deleteLanguage(languageId: string): Promise<void> {
  //   try {
  //     this.logger.debug(`Deleting language: ${languageId}`);
  //     const profile = await this.getProfile();
  //     await this.client.delete(`/people/(id:${profile.id})/languages/${languageId}`);
  //     this.logger.info(`Successfully deleted language: ${languageId}`);
  //   } catch (error: any) {
  //     if (error?.response?.status === 403) {
  //       throw new Error('Deleting languages requires LinkedIn partner-level API access (profile write scope), which is not available with a standard OAuth app.');
  //     }
  //     this.logger.error('Error deleting language', error);
  //     throw new Error(`Failed to delete language: ${error instanceof Error ? error.message : 'Unknown error'}`);
  //   }
  // }
}

